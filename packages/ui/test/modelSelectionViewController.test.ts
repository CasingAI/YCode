import assert from "node:assert/strict";
import test from "node:test";
import { SERVICE_ACCESSOR_CONNECTION, type ServiceAccessorConnection } from "@zcode/shared";
import type {
  IModelSelectionService,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/services";
import {
  createModelSelectionViewController,
  type ModelSelectionRetryScheduler,
} from "../src/hooks/modelSelectionViewController.js";

// 回归 docs/specs/model-selection-connection-recovery.md：
// Web facade 跨代稳定，但换代/断线会拒绝在途 RPC（ConnectionClosed）。
// 这里用真实异步 controller + 可控 connection port 复现连接生命周期，不用 React 或浏览器。

(
  globalThis as { __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean }
).__ZCODE_RENDERER_DISABLE_LOGGING__ = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function view(revision: number): ModelSelectionView {
  return {
    revision,
    providers: [],
  } as unknown as ModelSelectionView;
}

function connectionClosed(): Error {
  const error = new Error("WebSocket service generation 1 is not connected");
  error.name = "ConnectionClosed";
  return error;
}

function transientError(): Error {
  return Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
}

function createService(options: { withConnection: boolean; attachment?: object | null }) {
  const current = {
    attachment: options.attachment === undefined ? ({} as object) : options.attachment,
  };
  const eventListeners = new Set<(candidate: ModelSelectionView) => void>();
  const connectionListeners = new Set<() => void>();
  const calls: Array<{
    input: ModelSelectionViewInput | undefined;
    deferred: Deferred<ModelSelectionView>;
  }> = [];
  const serviceObject: Record<PropertyKey, unknown> = {
    getView: (input?: ModelSelectionViewInput) => {
      const deferred = defer<ModelSelectionView>();
      calls.push({ input, deferred });
      return deferred.promise;
    },
    onDidChange: (listener: (candidate: ModelSelectionView) => void) => {
      eventListeners.add(listener);
      return { dispose: () => eventListeners.delete(listener) };
    },
  };
  if (options.withConnection) {
    const port: ServiceAccessorConnection = {
      getAttachment: () => current.attachment,
      subscribe: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
    };
    serviceObject[SERVICE_ACCESSOR_CONNECTION] = port;
  }

  return {
    service: serviceObject as unknown as IModelSelectionService,
    calls,
    /** 断线：attachment 变 null，但 port 不通知（与 SwitchableServiceAccessor 一致）。 */
    detach(): void {
      current.attachment = null;
    },
    /** 新 attachment 就绪：先替换身份，再通知订阅者。 */
    attach(attachment: object): void {
      current.attachment = attachment;
      for (const listener of connectionListeners) listener();
    },
    emitChange(candidate: ModelSelectionView): void {
      for (const listener of eventListeners) listener(candidate);
    },
    eventListenerCount: () => eventListeners.size,
    connectionListenerCount: () => connectionListeners.size,
  };
}

function createHarness(options: {
  service: IModelSelectionService;
  input?: ModelSelectionViewInput;
  retainedView?: ModelSelectionView | null;
  resolvedCurrentInput?: boolean;
  scheduleRetry?: ModelSelectionRetryScheduler;
}) {
  const views: ModelSelectionView[] = [];
  const errors: Error[] = [];
  // 记录 controller 的完整状态出口序列，验证 error → loading → ready 而不只是错误数组。
  const states: string[] = [];
  const controller = createModelSelectionViewController({
    service: options.service,
    input: options.input,
    retainedView: options.retainedView ?? null,
    resolvedCurrentInput: options.resolvedCurrentInput ?? false,
    onLoading: () => states.push("loading"),
    onView: (candidate) => {
      views.push(candidate);
      states.push(`ready:${candidate.revision}`);
    },
    onError: (error) => {
      errors.push(error);
      states.push(`error:${error.message}`);
    },
    ...(options.scheduleRetry ? { scheduleRetry: options.scheduleRetry } : {}),
  });
  return { controller, views, errors, states };
}

test("首读被 attachment replacement 中断后，新 attachment 自动重读且不显示错误", async () => {
  const mock = createService({ withConnection: true });
  const { controller, views, errors } = createHarness({ service: mock.service });
  assert.equal(mock.calls.length, 1);

  // 连接换代：旧代在途 RPC 被 facade 拒绝，attachment 已是新代。
  mock.detach();
  mock.calls[0]!.deferred.reject(connectionClosed());
  await flush();
  assert.deepEqual(views, []);
  assert.deepEqual(errors, [], "transport 中断不能把首次目录卡成业务 error");

  mock.attach({});
  assert.equal(mock.calls.length, 2);
  mock.calls[1]!.deferred.resolve(view(3));
  await flush();
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [3],
    "新 attachment 就绪后无需 reload 即自动重读",
  );
  controller.dispose();
});

test("断开期间不发起读取，重连通知后读取成功", async () => {
  const connection = createService({ withConnection: true });
  connection.detach();
  const { controller, views, errors } = createHarness({ service: connection.service });

  assert.equal(connection.calls.length, 0, "attachment 为 null 时不得发读取");
  await flush();
  assert.deepEqual(views, []);
  assert.deepEqual(errors, []);

  connection.attach({});
  assert.equal(connection.calls.length, 1);
  connection.calls[0]!.deferred.resolve(view(1));
  await flush();
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [1],
  );
  controller.dispose();
});

test("旧请求后到不能覆盖新结果，事件领先时重读结果不能倒退", async () => {
  const mock = createService({ withConnection: true });
  const { controller, views } = createHarness({
    service: mock.service,
    input: { selection: { providerId: "deepseek", modelId: "glm-5.3" } },
  });

  // 事件推进 revision 到 10，并触发当前输入重读。
  mock.emitChange(view(10));
  assert.equal(mock.calls.length, 2);
  mock.calls[1]!.deferred.resolve(view(10));
  await flush();
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [10],
  );

  // 首读后到：requestId 已失效，不能覆盖已提交结果。
  mock.calls[0]!.deferred.resolve(view(99));
  await flush();
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [10],
    "旧请求后到不能覆盖/回退",
  );

  // 同一 attachment 内事件已到 20，重读返回 19 必须丢弃。
  mock.emitChange(view(20));
  assert.equal(mock.calls.length, 3);
  mock.calls[2]!.deferred.resolve(view(19));
  await flush();
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [10],
    "同一轮事件已推进 revision 时，更旧读取结果不得倒退目录",
  );
  controller.dispose();
});

test("已有目录跨 attachment 换代保留，读取失败不写 error", async () => {
  const retained = view(100);
  const mock = createService({ withConnection: true });
  const { controller, views, errors } = createHarness({
    service: mock.service,
    retainedView: retained,
    resolvedCurrentInput: true,
  });

  mock.detach();
  mock.calls[0]!.deferred.reject(connectionClosed());
  await flush();
  mock.attach({});
  assert.equal(mock.calls.length, 2);

  // 新代真正业务失败也不能丢掉既有目录。
  mock.calls[1]!.deferred.reject(new Error("provider registry failed"));
  await flush();
  assert.deepEqual(views, []);
  assert.deepEqual(errors, [], "已有目录时刷新失败必须保留目录且不显示错误");
  controller.dispose();
});

test("真正的业务失败仍写入 error，手动重建 controller 可重新读取", async () => {
  const mock = createService({ withConnection: true });
  const first = createHarness({ service: mock.service });
  mock.calls[0]!.deferred.reject(new Error("provider registry failed"));
  await flush();
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0]!.message, /provider registry failed/);
  assert.deepEqual(first.views, []);
  first.controller.dispose();

  // reload 等价路径：重新创建 controller 并再次读取。
  const second = createHarness({ service: mock.service });
  assert.equal(mock.calls.length, 2);
  mock.calls[1]!.deferred.resolve(view(2));
  await flush();
  assert.deepEqual(
    second.views.map((candidate) => candidate.revision),
    [2],
  );
  second.controller.dispose();
});

test("dispose 后旧成功/失败结果都不能写状态", async () => {
  const mock = createService({ withConnection: true });
  const { controller, views, errors } = createHarness({ service: mock.service });

  controller.dispose();
  mock.calls[0]!.deferred.resolve(view(5));
  await flush();
  assert.deepEqual(views, []);

  // 输入变化会重建 controller；旧 controller 的迟到失败同样必须丢弃。
  const next = createHarness({
    service: mock.service,
    input: { selection: { providerId: "deepseek", modelId: "next" } } as ModelSelectionViewInput,
  });
  assert.equal(mock.calls.length, 2);
  next.controller.dispose();
  mock.calls[1]!.deferred.reject(new Error("late"));
  await flush();
  assert.deepEqual(errors, []);
  assert.deepEqual(next.errors, []);
});

test("普通服务（无 connection port）保留首读瞬时错误的有界重试", async () => {
  const mock = createService({ withConnection: false });
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const scheduleRetry: ModelSelectionRetryScheduler = (run, delay) => {
    const entry = {
      delay,
      run: () => {
        // 模拟 setTimeout 已触发：条目在真正执行前从等待队列移除。
        const index = scheduled.indexOf(entry);
        if (index >= 0) scheduled.splice(index, 1);
        run();
      },
    };
    scheduled.push(entry);
    return () => {
      const index = scheduled.indexOf(entry);
      if (index >= 0) scheduled.splice(index, 1);
    };
  };
  const { controller, errors } = createHarness({ service: mock.service, scheduleRetry });
  assert.equal(mock.calls.length, 1);

  mock.calls[0]!.deferred.reject(transientError());
  await flush();
  assert.equal(errors.length, 1);
  assert.deepEqual(
    scheduled.map((entry) => entry.delay),
    [500],
  );

  scheduled[0]!.run();
  assert.equal(mock.calls.length, 2);
  mock.calls[1]!.deferred.reject(transientError());
  await flush();
  assert.deepEqual(
    scheduled.map((entry) => entry.delay),
    [1500],
  );

  scheduled[0]!.run();
  assert.equal(mock.calls.length, 3);
  mock.calls[2]!.deferred.reject(transientError());
  await flush();
  assert.deepEqual(scheduled, [], "只允许两次有界重试");
  assert.equal(errors.length, 3);
  controller.dispose();
});

test("有 connection port 时 ConnectionClosed 走一次性恢复，不排计时器", async () => {
  const mock = createService({ withConnection: true });
  const scheduled: number[] = [];
  const { controller, errors } = createHarness({
    service: mock.service,
    scheduleRetry: (_run, delay) => {
      scheduled.push(delay);
      return () => {};
    },
  });

  mock.calls[0]!.deferred.reject(connectionClosed());
  await flush();
  assert.deepEqual(scheduled, [], "连接恢复不能靠计时器轮询");
  assert.deepEqual(errors, [], "ConnectionClosed 不是业务错误");
  assert.equal(mock.calls.length, 2, "attachment 非空时允许一次立即只读恢复");
  controller.dispose();
});

test("无新 port 通知但 attachment 仍非空：一次 ConnectionClosed 后自动成功", async () => {
  const mock = createService({ withConnection: true });
  const { controller, views, errors, states } = createHarness({ service: mock.service });
  assert.equal(mock.calls.length, 1);

  // 真实 accessor 的 generation 提升可能按 service identity 过滤而不发 port 通知。
  mock.calls[0]!.deferred.reject(connectionClosed());
  await flush();
  assert.equal(mock.calls.length, 2, "不能只等待一个可能不会到来的通知");
  mock.calls[1]!.deferred.resolve(view(4));
  await flush();
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [4],
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(states, ["loading", "loading", "ready:4"]);
  controller.dispose();
});

test("持续 ConnectionClosed 不忙循环、不写 error，新 replacement 重置恢复预算", async () => {
  const mock = createService({ withConnection: true });
  const { controller, views, errors } = createHarness({ service: mock.service });

  mock.calls[0]!.deferred.reject(connectionClosed());
  await flush();
  assert.equal(mock.calls.length, 2);
  mock.calls[1]!.deferred.reject(connectionClosed());
  await flush();
  assert.equal(mock.calls.length, 2, "同一 attachment epoch 只允许一次自动恢复");
  assert.deepEqual(errors, []);
  assert.deepEqual(views, []);

  // 新 attachment 通知重置预算，并重新正常读取。
  mock.detach();
  mock.attach({});
  assert.equal(mock.calls.length, 3);
  mock.calls[2]!.deferred.reject(connectionClosed());
  await flush();
  assert.equal(mock.calls.length, 4);
  mock.calls[3]!.deferred.reject(connectionClosed());
  await flush();
  assert.equal(mock.calls.length, 4, "新 epoch 同样只允许一次自动恢复");
  assert.deepEqual(errors, []);
  assert.deepEqual(views, []);

  // 下一次 replacement 仍能恢复并提交。
  mock.detach();
  mock.attach({});
  assert.equal(mock.calls.length, 5);
  mock.calls[4]!.deferred.resolve(view(8));
  await flush();
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [8],
  );
  controller.dispose();
});

test("有 port 且已连接时，ECONNRESET 等瞬时错误仍保留两次有界重试", async () => {
  const mock = createService({ withConnection: true });
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const scheduleRetry: ModelSelectionRetryScheduler = (run, delay) => {
    const entry = {
      delay,
      run: () => {
        const index = scheduled.indexOf(entry);
        if (index >= 0) scheduled.splice(index, 1);
        run();
      },
    };
    scheduled.push(entry);
    return () => {
      const index = scheduled.indexOf(entry);
      if (index >= 0) scheduled.splice(index, 1);
    };
  };
  const { controller, errors } = createHarness({ service: mock.service, scheduleRetry });
  assert.equal(mock.calls.length, 1);

  mock.calls[0]!.deferred.reject(transientError());
  await flush();
  assert.deepEqual(
    scheduled.map((entry) => entry.delay),
    [500],
    "RPC 透传的 errno 不伴随 attachment 通知，必须自行有界重试",
  );

  scheduled[0]!.run();
  assert.equal(mock.calls.length, 2);
  mock.calls[1]!.deferred.reject(transientError());
  await flush();
  assert.deepEqual(
    scheduled.map((entry) => entry.delay),
    [1500],
  );

  scheduled[0]!.run();
  assert.equal(mock.calls.length, 3);
  mock.calls[2]!.deferred.reject(transientError());
  await flush();
  assert.deepEqual(scheduled, [], "只允许两次有界重试");
  assert.equal(errors.length, 3);
  controller.dispose();
});

test("新 attachment 通知会取消尚未触发的瞬时重试计时器", async () => {
  const mock = createService({ withConnection: true });
  const scheduled: Array<{ delay: number; run: () => void; cancelled: boolean }> = [];
  const { controller } = createHarness({
    service: mock.service,
    scheduleRetry: (run, delay) => {
      const entry = { delay, run, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
        const index = scheduled.indexOf(entry);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
  });

  mock.calls[0]!.deferred.reject(transientError());
  await flush();
  assert.equal(scheduled.length, 1);
  const pending = scheduled[0]!;

  mock.detach();
  mock.attach({});
  assert.equal(pending.cancelled, true);
  assert.equal(mock.calls.length, 2, "新 attachment 立即重读，旧计时器不再执行");
  controller.dispose();
});

test("无目录时业务失败后，新 attachment 读取先回到 loading 再 ready", async () => {
  const mock = createService({ withConnection: true });
  const { controller, views, errors, states } = createHarness({ service: mock.service });
  assert.deepEqual(states, ["loading"]);

  mock.calls[0]!.deferred.reject(new Error("provider registry failed"));
  await flush();
  assert.deepEqual(states, ["loading", "error:provider registry failed"]);

  mock.detach();
  mock.attach({});
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(
    states,
    ["loading", "error:provider registry failed", "loading"],
    "重新读取前必须清除旧业务 error",
  );

  mock.calls[1]!.deferred.resolve(view(2));
  await flush();
  assert.deepEqual(states.slice(-1), ["ready:2"]);
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [2],
  );
  assert.equal(errors.length, 1);
  controller.dispose();
});

test("已有目录时读取/等待都不调用 onLoading", async () => {
  const mock = createService({ withConnection: true });
  const { controller, views, states, errors } = createHarness({
    service: mock.service,
    retainedView: view(100),
    resolvedCurrentInput: true,
  });
  assert.deepEqual(states, []);

  mock.calls[0]!.deferred.reject(connectionClosed());
  await flush();
  assert.deepEqual(states, [], "有目录时 transport 恢复不能把状态退回 loading");
  assert.deepEqual(errors, []);
  assert.equal(mock.calls.length, 2);

  mock.calls[1]!.deferred.resolve(view(101));
  await flush();
  assert.deepEqual(states, ["ready:101"]);
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [101],
  );
  controller.dispose();
});

test("dispose 释放 onDidChange 与 connection port 订阅", () => {
  const mock = createService({ withConnection: true });
  const { controller } = createHarness({ service: mock.service });
  assert.equal(mock.eventListenerCount(), 1);
  assert.equal(mock.connectionListenerCount(), 1);

  controller.dispose();
  assert.equal(mock.eventListenerCount(), 0);
  assert.equal(mock.connectionListenerCount(), 0);
});

test("新 attachment 的 revision 可以从低值重新起步", async () => {
  const mock = createService({ withConnection: true });
  const { controller, views } = createHarness({
    service: mock.service,
    retainedView: view(100),
    resolvedCurrentInput: true,
  });

  mock.calls[0]!.deferred.resolve(view(100));
  await flush();
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [100],
  );

  // 服务重启：新 attachment 的目录 revision 从 1 开始，旧代 100 不能永久压制它。
  mock.detach();
  mock.attach({});
  assert.equal(mock.calls.length, 2);
  mock.calls[1]!.deferred.resolve(view(1));
  await flush();
  assert.deepEqual(
    views.map((candidate) => candidate.revision),
    [100, 1],
  );
  controller.dispose();
});

test("换代前发出的读取不能进入新代作用域（迟到成功/中断/业务失败）", async (t) => {
  type PendingCall = { deferred: Deferred<ModelSelectionView> };
  const cases: Array<[string, (call: PendingCall) => void]> = [
    ["迟到成功", (call) => call.deferred.resolve(view(99))],
    ["迟到 ConnectionClosed", (call) => call.deferred.reject(connectionClosed())],
    ["迟到业务失败", (call) => call.deferred.reject(new Error("late business failure"))],
  ];

  for (const [name, settle] of cases) {
    await t.test(name, async () => {
      const mock = createService({ withConnection: true });
      const { controller, views, errors } = createHarness({ service: mock.service });

      mock.detach();
      mock.attach({});
      assert.equal(mock.calls.length, 2);

      // 每个用例使用独立的 promise；旧请求结算后不得写状态。
      settle(mock.calls[0]!);
      await flush();
      assert.deepEqual(views, []);
      assert.deepEqual(errors, []);

      mock.calls[1]!.deferred.resolve(view(1));
      await flush();
      assert.deepEqual(
        views.map((candidate) => candidate.revision),
        [1],
      );
      controller.dispose();
    });
  }
});
