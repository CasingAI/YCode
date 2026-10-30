import assert from "node:assert/strict";
import test from "node:test";
import {
  measureRendererPerformance,
  recordRendererPerformanceDuration,
  startRendererPerformanceDiagnostics,
  type RendererPerformanceDiagnosticsHandle,
  type RendererPerformanceDiagnosticsOptions,
  type RendererPerformanceScheduler,
  type RendererPerformanceSummaryV1,
  type RendererPerformanceVisibility,
} from "../src/lib/rendererPerformanceDiagnostics.js";

// 这些测试只驱动注入的 clock/scheduler/observer/visibility，不依赖真实等待，
// 也不接触正在运行的 YCode。所有断言都围绕数值聚合和清理语义，不回读业务内容。

function createClock(startAt = 0) {
  let current = startAt;
  let reads = 0;
  return {
    now: () => {
      reads += 1;
      return current;
    },
    set(value: number) {
      current = value;
    },
    advance(value: number) {
      current += value;
    },
    get reads() {
      return reads;
    },
  };
}

function createScheduler(): {
  scheduler: RendererPerformanceScheduler;
  tasks: Map<number, { callback: () => void; ms: number }>;
  fireByMs(ms: number): void;
  pendingMs(): number[];
} {
  let nextId = 1;
  const tasks = new Map<number, { callback: () => void; ms: number }>();
  const scheduler: RendererPerformanceScheduler = {
    setInterval(callback, ms) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, ms });
      return id;
    },
    clearInterval(handle) {
      tasks.delete(handle as number);
    },
  };
  return {
    scheduler,
    tasks,
    fireByMs(ms) {
      for (const task of Array.from(tasks.values())) {
        if (task.ms === ms) {
          task.callback();
        }
      }
    },
    pendingMs() {
      return [...tasks.values()].map((task) => task.ms).sort((a, b) => a - b);
    },
  };
}

function createVisibility() {
  let visible = true;
  let focused = true;
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const emit = (type: string) => {
    for (const listener of Array.from(listeners.get(type) ?? [])) {
      listener({} as Event);
    }
  };
  const visibility: RendererPerformanceVisibility = {
    isVisible: () => visible,
    isFocused: () => focused,
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    visibility,
    setVisible(value: boolean) {
      visible = value;
      emit("visibilitychange");
    },
    setFocused(value: boolean) {
      focused = value;
      emit(value ? "focus" : "blur");
    },
    pagehide() {
      emit("pagehide");
    },
    listenerCount() {
      let count = 0;
      for (const bucket of listeners.values()) {
        count += bucket.size;
      }
      return count;
    },
  };
}

function createRaf() {
  let nextId = 1;
  const callbacks = new Map<number, (timestamp: number) => void>();
  return {
    request(callback: (timestamp: number) => void) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancel(handle: number) {
      callbacks.delete(handle);
    },
    frame(timestamp: number) {
      const current = [...callbacks.values()];
      callbacks.clear();
      for (const callback of current) {
        callback(timestamp);
      }
    },
    pending() {
      return callbacks.size;
    },
    captured(): Array<(timestamp: number) => void> {
      return [...callbacks.values()];
    },
  };
}

function createObservers(options: {
  supported?: Set<string>;
  failObserve?: Set<string>;
  throwFactory?: Set<string>;
}) {
  const supported = options.supported ?? new Set(["longtask", "long-animation-frame"]);
  const failObserve = options.failObserve ?? new Set<string>();
  const throwFactory = options.throwFactory ?? new Set<string>();
  const callbacks = new Map<string, Set<(entries: readonly PerformanceEntry[]) => void>>();
  const created = new Map<string, Array<(entries: readonly PerformanceEntry[]) => void>>();
  const disconnected = new Set<string>();
  const observeErrors: string[] = [];
  const observerFactory = (
    type: string,
    callback: (entries: readonly PerformanceEntry[]) => void,
  ) => {
    if (throwFactory.has(type)) {
      throw new Error(`factory:${type}`);
    }
    if (!supported.has(type)) {
      return null;
    }
    created.set(type, [...(created.get(type) ?? []), callback]);
    return {
      observe() {
        if (failObserve.has(type)) {
          observeErrors.push(type);
          throw new Error(`observe:${type}`);
        }
        const bucket = callbacks.get(type) ?? new Set();
        bucket.add(callback);
        callbacks.set(type, bucket);
      },
      disconnect() {
        disconnected.add(type);
        callbacks.get(type)?.delete(callback);
      },
    };
  };
  return {
    observerFactory:
      observerFactory as unknown as RendererPerformanceDiagnosticsOptions["observerFactory"],
    emit(type: string, entries: readonly PerformanceEntry[]) {
      for (const callback of Array.from(callbacks.get(type) ?? [])) {
        callback(entries);
      }
    },
    stale(type: string) {
      return created.get(type)?.[0];
    },
    disconnected,
    observeErrors,
    active(type: string) {
      return (callbacks.get(type)?.size ?? 0) > 0;
    },
  };
}

interface Harness {
  handle: RendererPerformanceDiagnosticsHandle;
  clock: ReturnType<typeof createClock>;
  scheduler: ReturnType<typeof createScheduler>;
  visibility: ReturnType<typeof createVisibility>;
  raf: ReturnType<typeof createRaf>;
  summaries: RendererPerformanceSummaryV1[];
}

function startHarness(overrides: RendererPerformanceDiagnosticsOptions = {}): Harness {
  const clock = createClock();
  const scheduler = createScheduler();
  const visibility = createVisibility();
  const raf = createRaf();
  const summaries: RendererPerformanceSummaryV1[] = [];
  const handle = startRendererPerformanceDiagnostics({
    windowMs: 1_000,
    now: clock.now,
    scheduler: scheduler.scheduler,
    visibility: visibility.visibility,
    requestAnimationFrame: raf.request,
    cancelAnimationFrame: raf.cancel,
    observerFactory: noopObserverFactory(),
    write: (summary) => summaries.push(summary),
    ...overrides,
  });
  return { handle, clock, scheduler, visibility, raf, summaries };
}

function noopObserverFactory(): NonNullable<
  RendererPerformanceDiagnosticsOptions["observerFactory"]
> {
  return () => null;
}

function latest(summaries: RendererPerformanceSummaryV1[]): RendererPerformanceSummaryV1 {
  const summary = summaries.at(-1);
  assert.ok(summary, "expected a summary");
  return summary;
}

test("未启动时 measure/record 是 hot-path no-op，disabled start 也不读取 clock", () => {
  assert.equal(
    measureRendererPerformance("sessions-index.items", () => 42, 3),
    42,
  );
  recordRendererPerformanceDuration("react.session-pane", 12);

  const clock = createClock(100);
  const summaries: RendererPerformanceSummaryV1[] = [];
  const handle = startRendererPerformanceDiagnostics({
    enabled: false,
    now: clock.now,
    write: (summary) => summaries.push(summary),
  });
  assert.equal(
    measureRendererPerformance("conversation.frame", () => "value"),
    "value",
  );
  recordRendererPerformanceDuration("conversation.turn-frame", 5);
  assert.equal(clock.reads, 0);
  assert.equal(summaries.length, 0);
  handle.flush();
  handle.stop();
});

test("clock 抛错或返回非有限值时仍原样执行 run", () => {
  let clockMode: "throw" | "nan" | "ok" = "throw";
  const summaries: RendererPerformanceSummaryV1[] = [];
  const handle = startRendererPerformanceDiagnostics({
    windowMs: 1_000,
    now: () => {
      if (clockMode === "throw") {
        throw new Error("clock failed");
      }
      return clockMode === "nan" ? Number.NaN : 1;
    },
    scheduler: createScheduler().scheduler,
    visibility: createVisibility().visibility,
    requestAnimationFrame: () => undefined,
    observerFactory: noopObserverFactory(),
    write: (summary) => summaries.push(summary),
  });
  try {
    assert.equal(
      measureRendererPerformance("conversation.frame", () => 7),
      7,
    );
    clockMode = "nan";
    assert.equal(
      measureRendererPerformance("conversation.frame", () => 8),
      8,
    );
    handle.flush();
    assert.equal(summaries.length, 0);
  } finally {
    handle.stop();
  }
});

test("run 抛出的异常 identity 保真，finally 中的诊断不替换异常", () => {
  const harness = startHarness();
  const failure = new Error("business failure");
  try {
    harness.clock.set(0);
    assert.throws(
      () =>
        measureRendererPerformance("sessions-index.items", () => {
          harness.clock.set(5);
          throw failure;
        }),
      (error) => error === failure,
    );
    harness.handle.flush();
    const summary = latest(harness.summaries);
    assert.equal(summary.stages["sessions-index.items"]?.count, 1);
    assert.equal(summary.stages["sessions-index.items"]?.durationMsSum, 5);
  } finally {
    harness.handle.stop();
  }
});

test("return Promise identity 保真，异步阶段不进入本次时长", () => {
  const harness = startHarness();
  try {
    const promise = Promise.resolve("ok");
    harness.clock.set(0);
    const result = measureRendererPerformance("conversation.share-units", () => promise, 4);
    assert.equal(result, promise);
    harness.handle.flush();
    const summary = latest(harness.summaries);
    assert.equal(summary.stages["conversation.share-units"]?.count, 1);
    assert.equal(summary.stages["conversation.share-units"]?.durationMsSum, 0);
    assert.equal(summary.stages["conversation.share-units"]?.workUnitsSum, 4);
  } finally {
    harness.handle.stop();
  }
});

test("引用计数：首次 stop 不清理，归零才清理；旧 handle 不影响重启实例", () => {
  const clock = createClock();
  const firstScheduler = createScheduler();
  const firstSummaries: RendererPerformanceSummaryV1[] = [];
  const first = startRendererPerformanceDiagnostics({
    windowMs: 1_000,
    now: clock.now,
    scheduler: firstScheduler.scheduler,
    visibility: createVisibility().visibility,
    requestAnimationFrame: () => 1,
    observerFactory: noopObserverFactory(),
    write: (summary) => firstSummaries.push(summary),
  });
  const second = startRendererPerformanceDiagnostics({ windowMs: 9_999 });

  try {
    clock.set(0);
    measureRendererPerformance("sessions-index.items", () => undefined, 2);
    first.stop();
    assert.equal(firstScheduler.tasks.size, 2, "引用计数未归零时应保留 window timer 与采样 timer");

    clock.set(3);
    measureRendererPerformance("sessions-index.items", () => undefined, 3);
    firstScheduler.fireByMs(1_000);
    assert.equal(firstSummaries.length, 1);
    assert.equal(firstSummaries[0]?.stages["sessions-index.items"]?.count, 2);
    assert.equal(firstSummaries[0]?.stages["sessions-index.items"]?.workUnitsSum, 5);

    second.stop();
    assert.equal(firstScheduler.tasks.size, 0);

    const thirdSummaries: RendererPerformanceSummaryV1[] = [];
    const third = startRendererPerformanceDiagnostics({
      windowMs: 1_000,
      now: clock.now,
      scheduler: firstScheduler.scheduler,
      visibility: createVisibility().visibility,
      requestAnimationFrame: () => 1,
      observerFactory: noopObserverFactory(),
      write: (summary) => thirdSummaries.push(summary),
    });
    try {
      first.flush();
      second.flush();
      first.stop();
      second.stop();
      clock.set(10);
      measureRendererPerformance("conversation.turn-frame", () => undefined, 1);
      third.flush();
      assert.equal(thirdSummaries.length, 1);
      assert.equal(thirdSummaries[0]?.stages["conversation.turn-frame"]?.count, 1);
    } finally {
      third.stop();
    }
  } finally {
    first.stop();
    second.stop();
  }
});

test("pagehide 触发一次 flush + 完整清理，stale 回调不再写入", () => {
  const observers = createObservers({
    supported: new Set(["longtask", "long-animation-frame"]),
  });
  const harness = startHarness({
    observerFactory: observers.observerFactory,
  });
  const staleLongTask = observers.stale("longtask");
  assert.ok(staleLongTask, "expected a created longtask callback");

  try {
    harness.clock.set(0);
    measureRendererPerformance("sessions-index.items", () => undefined, 1);
    harness.raf.frame(10);
    harness.raf.frame(120);
    const staleFrame = harness.raf.captured()[0];
    const staleWindowTimer = [...harness.scheduler.tasks.values()].find(
      (task) => task.ms === 1_000,
    )?.callback;
    assert.ok(staleFrame);
    assert.ok(staleWindowTimer);

    harness.visibility.pagehide();
    assert.equal(harness.summaries.length, 1);
    assert.equal(harness.scheduler.tasks.size, 0);
    assert.equal(harness.raf.pending(), 0);
    assert.equal(observers.active("longtask"), false);
    assert.equal(harness.visibility.listenerCount(), 0);

    const clockReads = harness.clock.reads;
    staleLongTask([{ duration: 30 } as PerformanceEntry]);
    staleFrame(10_000);
    staleWindowTimer();
    assert.equal(harness.summaries.length, 1);
    assert.equal(harness.clock.reads, clockReads, "清理后不应再读取 clock");
    assert.equal(
      measureRendererPerformance("conversation.frame", () => "after"),
      "after",
    );
  } finally {
    harness.handle.stop();
  }
});

test("writer 抛错只丢当前窗口，下一窗口重新计数", () => {
  const summaries: RendererPerformanceSummaryV1[] = [];
  let writes = 0;
  const clock = createClock();
  const scheduler = createScheduler();
  const handle = startRendererPerformanceDiagnostics({
    windowMs: 1_000,
    now: clock.now,
    scheduler: scheduler.scheduler,
    visibility: createVisibility().visibility,
    requestAnimationFrame: () => 1,
    observerFactory: noopObserverFactory(),
    write: (summary) => {
      writes += 1;
      if (writes === 1) {
        throw new Error("writer failed");
      }
      summaries.push(summary);
    },
  });
  try {
    clock.set(0);
    measureRendererPerformance("sessions-index.items", () => undefined, 1);
    scheduler.fireByMs(1_000);
    assert.equal(writes, 1);
    assert.equal(summaries.length, 0);

    clock.set(4);
    measureRendererPerformance("sessions-index.items", () => undefined, 2);
    scheduler.fireByMs(1_000);
    assert.equal(writes, 2);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.stages["sessions-index.items"]?.count, 1);
    assert.equal(summaries[0]?.stages["sessions-index.items"]?.workUnitsSum, 2);
  } finally {
    handle.stop();
  }
});

test("非有限/负数样本被忽略，合法 0 保留；frame stage 忽略 workUnits", () => {
  const harness = startHarness();
  try {
    harness.clock.set(0);
    measureRendererPerformance("conversation.frame", () => undefined, 99);
    recordRendererPerformanceDuration("sessions-index.items", Number.NaN, 1);
    recordRendererPerformanceDuration("sessions-index.items", Number.POSITIVE_INFINITY, 1);
    recordRendererPerformanceDuration("sessions-index.items", -1, 1);
    recordRendererPerformanceDuration("sessions-index.items", 0, 0);
    recordRendererPerformanceDuration("conversation.turn-frame", 2.5, Number.NaN);

    harness.handle.flush();
    const summary = latest(harness.summaries);
    const frame = summary.stages["conversation.frame"];
    assert.equal(frame?.count, 1);
    assert.equal("workUnitsSum" in (frame ?? {}), false);
    assert.equal("workUnitsMax" in (frame ?? {}), false);
    const items = summary.stages["sessions-index.items"];
    assert.equal(items?.count, 1);
    assert.equal(items?.durationMsSum, 0);
    assert.equal(items?.durationMsMax, 0);
    assert.equal(items?.workUnitsSum, 0);
    assert.equal(items?.workUnitsMax, 0);
    const turn = summary.stages["conversation.turn-frame"];
    assert.equal(turn?.durationMsSum, 2.5);
    assert.equal("workUnitsSum" in (turn ?? {}), false);
    assert.equal(JSON.stringify(summary).includes("durations"), false);
  } finally {
    harness.handle.stop();
  }
});

test("按窗口分组：有活动窗口写一条，空窗不写，flush 提前关窗", () => {
  const harness = startHarness();
  try {
    harness.clock.set(0);
    measureRendererPerformance("sessions-index.items", () => undefined, 1);
    measureRendererPerformance("conversation.turn-frame", () => undefined, 4);
    harness.scheduler.fireByMs(1_000);
    assert.equal(harness.summaries.length, 1);
    assert.equal(harness.summaries[0]?.stages["sessions-index.items"]?.count, 1);
    assert.equal(harness.summaries[0]?.stages["conversation.turn-frame"]?.workUnitsSum, 4);

    harness.scheduler.fireByMs(1_000);
    assert.equal(harness.summaries.length, 1, "空窗不应写日志");

    measureRendererPerformance("conversation.frame", () => undefined);
    harness.handle.flush();
    assert.equal(harness.summaries.length, 2);
    assert.equal(harness.summaries[1]?.stages["conversation.frame"]?.count, 1);

    harness.handle.flush();
    assert.equal(harness.summaries.length, 2, "重复 flush 不应重复写空窗");
  } finally {
    harness.handle.stop();
  }
});

test("不支持 PerformanceObserver / rAF 时 capabilities 为 false 且不采样", () => {
  const harness = startHarness({
    requestAnimationFrame: undefined,
    cancelAnimationFrame: undefined,
    observerFactory: noopObserverFactory(),
  });
  try {
    harness.clock.set(0);
    harness.handle.flush();
    assert.equal(harness.summaries.length, 0);
    recordRendererPerformanceDuration("sessions-index.items", 1);
    harness.handle.flush();
    const summary = latest(harness.summaries);
    assert.equal(summary.capabilities.longTask, false);
    assert.equal(summary.capabilities.longAnimationFrame, false);
    assert.equal(summary.capabilities.requestAnimationFrame, false);
    assert.equal(summary.runtime.longTask, undefined);
    assert.equal(summary.runtime.loaf, undefined);
    assert.equal(summary.runtime.raf, undefined);
    assert.equal(harness.raf.pending(), 0);
  } finally {
    harness.handle.stop();
  }
});

test("observer 部分启动失败会 disconnect 失败项，其他 observer 不受影响", () => {
  const observers = createObservers({
    supported: new Set(["longtask", "long-animation-frame"]),
    failObserve: new Set(["longtask"]),
  });
  const harness = startHarness({ observerFactory: observers.observerFactory });
  try {
    assert.deepEqual(observers.observeErrors, ["longtask"]);
    assert.equal(observers.disconnected.has("longtask"), true);
    assert.equal(observers.active("long-animation-frame"), true);

    observers.emit("long-animation-frame", [
      {
        startTime: 10,
        duration: 60,
        blockingDuration: 20,
        renderStart: 15,
        styleAndLayoutStart: 25,
        scripts: [
          { duration: 10, forcedStyleAndLayoutDuration: 2 },
          { duration: 5, forcedStyleAndLayoutDuration: 3 },
        ],
      } as PerformanceEntry,
    ]);
    harness.handle.flush();
    const summary = latest(harness.summaries);
    assert.equal(summary.capabilities.longTask, false);
    assert.equal(summary.capabilities.longAnimationFrame, true);
    assert.equal(summary.runtime.longTask, undefined);
    assert.equal(summary.runtime.loaf?.count, 1);
    assert.equal(summary.runtime.loaf?.durationMsSum, 60);
    assert.equal(summary.runtime.loaf?.blockingDurationMsSum, 20);
    assert.equal(summary.runtime.loaf?.scriptDurationMsSum, 15);
    assert.equal(summary.runtime.loaf?.forcedStyleAndLayoutDurationMsSum, 5);
    assert.equal(summary.runtime.loaf?.renderPhaseMsSum, 10);
    assert.equal(summary.runtime.loaf?.styleAndLayoutPhaseMsSum, 45);
    assert.equal(summary.observed.loafEntries, 1);
  } finally {
    harness.handle.stop();
  }
});

test("LoAF 字段缺失/非法时省略，合法 0 保留，长任务分开计数", () => {
  const observers = createObservers({
    supported: new Set(["longtask", "long-animation-frame"]),
  });
  const harness = startHarness({ observerFactory: observers.observerFactory });
  try {
    observers.emit("longtask", [{ duration: 0 } as PerformanceEntry]);
    observers.emit("long-animation-frame", [
      {
        startTime: 100,
        duration: 0,
        blockingDuration: 0,
        scripts: [{ duration: Number.NaN }, {}],
      } as PerformanceEntry,
      {
        startTime: 200,
        duration: 40,
        renderStart: 210,
        styleAndLayoutStart: 205,
      } as PerformanceEntry,
    ]);
    harness.handle.flush();
    const summary = latest(harness.summaries);
    assert.equal(summary.runtime.longTask?.count, 1);
    assert.equal(summary.runtime.longTask?.durationMsSum, 0);
    assert.equal(summary.runtime.loaf?.count, 2);
    assert.equal(summary.runtime.loaf?.durationMsSum, 40);
    assert.equal(summary.runtime.loaf?.blockingDurationMsSum, 0);
    assert.equal("scriptDurationMsSum" in (summary.runtime.loaf ?? {}), false);
    assert.equal("forcedStyleAndLayoutDurationMsSum" in (summary.runtime.loaf ?? {}), false);
    assert.equal("renderPhaseMsSum" in (summary.runtime.loaf ?? {}), false);
    assert.equal(summary.runtime.loaf?.styleAndLayoutPhaseMsSum, 35);
    assert.equal(summary.observed.longTaskEntries, 1);
    assert.equal(summary.observed.loafEntries, 2);
  } finally {
    harness.handle.stop();
  }
});

test("observer 按回调交付窗口归属，不回填 startTime 所在旧窗口", () => {
  const observers = createObservers({
    supported: new Set(["longtask"]),
  });
  const harness = startHarness({ observerFactory: observers.observerFactory });
  try {
    harness.clock.set(0);
    observers.emit("longtask", [{ startTime: 5_000, duration: 30 } as PerformanceEntry]);
    harness.scheduler.fireByMs(1_000);
    assert.equal(harness.summaries.length, 1);
    assert.equal(harness.summaries[0]?.runtime.longTask?.count, 1);

    harness.clock.set(11_000);
    observers.emit("longtask", [{ startTime: 10, duration: 40 } as PerformanceEntry]);
    harness.scheduler.fireByMs(1_000);
    assert.equal(harness.summaries.length, 2);
    assert.equal(harness.summaries[1]?.runtime.longTask?.count, 1);
    assert.equal(harness.summaries[1]?.runtime.longTask?.durationMsSum, 40);
    assert.equal(harness.summaries[0]?.runtime.longTask?.durationMsSum, 30);
  } finally {
    harness.handle.stop();
  }
});

test("失焦/隐藏停止采样并重置 baseline，恢复后首帧/首周期不计入", () => {
  const harness = startHarness();
  try {
    harness.raf.frame(100);
    harness.raf.frame(216);
    assert.equal(harness.raf.pending(), 1);

    const staleFrame = harness.raf.captured()[0];
    assert.ok(staleFrame);
    harness.visibility.setFocused(false);
    assert.equal(harness.raf.pending(), 0);
    assert.deepEqual(harness.scheduler.pendingMs(), [1_000]);
    staleFrame(10_000);

    harness.visibility.setFocused(true);
    assert.equal(harness.raf.pending(), 1);
    assert.deepEqual(harness.scheduler.pendingMs(), [500, 1_000]);
    harness.raf.frame(1_000);
    harness.raf.frame(1_120);

    harness.clock.set(1_120);
    harness.scheduler.fireByMs(500);
    harness.clock.set(1_700);
    harness.scheduler.fireByMs(500);

    harness.visibility.setVisible(false);
    assert.deepEqual(harness.scheduler.pendingMs(), [1_000]);
    assert.equal(harness.raf.pending(), 0);
    harness.visibility.setVisible(true);
    assert.deepEqual(harness.scheduler.pendingMs(), [500, 1_000]);
    harness.scheduler.fireByMs(500);
    harness.clock.set(2_300);
    harness.scheduler.fireByMs(500);

    harness.handle.flush();
    const summary = latest(harness.summaries);
    assert.equal(summary.runtime.raf?.count, 2);
    assert.equal(summary.runtime.raf?.intervalMsMax, 120);
    assert.equal(summary.runtime.raf?.over50msCount, 2);
    assert.equal(summary.runtime.timer?.count, 2);
    assert.equal(summary.runtime.timer?.delayMsMax, 100);
    assert.equal(summary.observed.rafSamples, 2);
    assert.equal(summary.observed.timerSamples, 2);
  } finally {
    harness.handle.stop();
  }
});

test("React Profiler 记录只在显式 dev 标记下声明可用", () => {
  const harness = startHarness({ profilingEnabled: true });
  try {
    recordRendererPerformanceDuration("react.session-pane", 12.5, 99);
    harness.handle.flush();
    const summary = latest(harness.summaries);
    assert.equal(summary.capabilities.reactProfiler, "dev-only");
    assert.equal(summary.stages["react.session-pane"]?.count, 1);
    assert.equal(summary.stages["react.session-pane"]?.durationMsSum, 12.5);
    assert.equal("workUnitsSum" in (summary.stages["react.session-pane"] ?? {}), false);
    assert.equal(summary.observed.reactProfilerCallbacks, 1);
  } finally {
    harness.handle.stop();
  }
});
