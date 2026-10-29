// ============================================================
// Sandbox Worker 化测试（spec 验收 31–38 / 43–44 的单测版）
// ============================================================
// 每个用例都真实创建 worker_threads Worker：guest 的 CPU 死循环、定时器
// 回调死循环与控制台 eval 死循环都不能挡住主线程的定时器、V4 查询或其它
// 会话；reset 直接 terminate，旧 generation 的迟到消息被丢弃。

import assert from "node:assert/strict";
import test from "node:test";
import type { SessionId } from "@zcode/contracts";
import { SandboxInstance, type SandboxWorkerPort } from "../src/sandbox/instance.js";
import { SandboxInstanceTable } from "../src/sandbox/instance-table.js";
import { createSandboxSyncHostCallSignal } from "../src/sandbox/sync-bridge.js";
import { resolveSandboxWorkerAssets } from "../src/sandbox/worker-assets.js";

function session(name: string): SessionId {
  return `${name}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}` as SessionId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(message);
}

test("400ms CPU 循环期间主线程 25ms 定时器仍准时触发", { timeout: 10_000 }, async () => {
  const instance = await SandboxInstance.create();
  let ticks = 0;
  const interval = setInterval(() => {
    ticks += 1;
  }, 25);
  try {
    const pending = instance.eval(
      "const end = Date.now() + 400; while (Date.now() < end) {} return 'cpu-done';",
    );
    const sleepStarted = Date.now();
    await delay(150);
    const slept = Date.now() - sleepStarted;
    // 主线程若被 guest 循环阻塞，这个 150ms sleep 会拖到循环结束（>=400ms），
    // 期间 interval 也不会触发。这里同时钉住时间与次数。
    assert.ok(slept < 300, `main thread sleep was blocked: ${slept}ms`);
    assert.ok(ticks >= 4, `main thread timers did not fire promptly: ${ticks}`);
    const outcome = await pending;
    assert.equal(outcome.result.kind, "completed");
    if (outcome.result.kind !== "completed") return;
    assert.equal(outcome.result.returnText, "cpu-done");
  } finally {
    clearInterval(interval);
    instance.dispose();
  }
});

test(
  "await 之后的同步死循环：主线程仍响应，reset 立即完成并重建干净实例",
  { timeout: 15_000 },
  async () => {
    const table = new SandboxInstanceTable();
    const sid = session("sess_worker_await_loop");
    try {
      const pending = table.eval({
        sessionId: sid,
        code: "await new Promise((resolve) => setTimeout(resolve, 0)); while (true) {}",
        timeoutMs: 60_000,
      });
      await delay(120);
      const started = Date.now();
      await table.reset(sid);
      const resetMs = Date.now() - started;
      assert.ok(resetMs < 8_000, `reset waited on a busy worker: ${resetMs}ms`);
      const outcome = await pending;
      assert.equal(outcome.result.kind, "failed");
      assert.equal(outcome.instanceAlive, false);

      const check = await table.eval({ sessionId: sid, code: "return 6 * 7;", timeoutMs: 10_000 });
      assert.equal(check.result.kind, "completed");
      if (check.result.kind !== "completed") return;
      assert.equal(check.result.returnText, "42");
    } finally {
      table.disposeAll();
    }
  },
);

test("控制台用户 eval 死循环：主线程可 reset，新实例可用", { timeout: 15_000 }, async () => {
  const table = new SandboxInstanceTable();
  const sid = session("sess_worker_user_loop");
  try {
    const pending = table.evalWithSource(
      { sessionId: sid, code: "while (true) {}", timeoutMs: 60_000 },
      "user",
    );
    await delay(120);
    const started = Date.now();
    await table.reset(sid);
    assert.ok(Date.now() - started < 8_000);
    const outcome = await pending;
    assert.equal(outcome.result.kind, "failed");

    const check = await table.evalWithSource(
      { sessionId: sid, code: "1 + 1", timeoutMs: 10_000 },
      "user",
    );
    assert.equal(check.result.kind, "completed");
    if (check.result.kind !== "completed") return;
    assert.equal(check.result.returnText, "2");
  } finally {
    table.disposeAll();
  }
});

test(
  "定时器回调死循环：eval 正常结算后主线程仍响应，实例可 reset",
  { timeout: 15_000 },
  async () => {
    const table = new SandboxInstanceTable();
    const sid = session("sess_worker_timer_loop");
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 25);
    try {
      const started = await table.eval({
        sessionId: sid,
        code: 'setInterval(() => { while (true) {} }, 0); return "started";',
        timeoutMs: 10_000,
      });
      assert.equal(started.result.kind, "completed");
      if (started.result.kind !== "completed") return;
      assert.equal(started.result.returnText, "started");
      await delay(150);
      assert.ok(ticks >= 4, `main thread blocked by timer callback: ${ticks}`);
      const resetStarted = Date.now();
      await table.reset(sid);
      assert.ok(Date.now() - resetStarted < 8_000);
    } finally {
      clearInterval(interval);
      table.disposeAll();
    }
  },
);

test("console 投影：死循环期间主线程已能看到日志", { timeout: 15_000 }, async () => {
  const instance = await SandboxInstance.create();
  try {
    const pending = instance.eval(
      'console.log("x-during-loop"); const end = Date.now() + 60_000; while (Date.now() < end) {}',
    );
    await waitUntil(
      () => instance.readConsoleWindow({ filter: "x-during-loop" }).lines.length === 1,
      "console line was not projected while the worker was busy",
    );
    instance.dispose();
    const outcome = await pending;
    assert.equal(outcome.result.kind, "failed");
  } finally {
    instance.dispose();
  }
});

test(
  "LocalStorage 投影：写入后死循环，reset 后新实例读到值且提示只一次",
  { timeout: 20_000 },
  async () => {
    const table = new SandboxInstanceTable();
    const sid = session("sess_worker_ls_loop");
    try {
      const pending = table.eval({
        sessionId: sid,
        code: 'localStorage.setItem("k", "v"); console.log("ls-done"); const end = Date.now() + 60_000; while (Date.now() < end) {}',
        timeoutMs: 60_000,
      });
      // console 与 local-storage 事件同通道有序：看到 console 时镜像必然已应用。
      await waitUntil(
        () => table.readConsoleSnapshot(sid).lines.some((line) => line.text.includes("ls-done")),
        "localStorage console marker was not projected",
      );
      await table.reset(sid);
      await pending;

      const next = await table.eval({
        sessionId: sid,
        code: 'return localStorage.getItem("k");',
        timeoutMs: 10_000,
      });
      assert.equal(next.result.kind, "completed");
      if (next.result.kind !== "completed") return;
      assert.equal(next.result.returnText, "v");
      // reset 已建出新实例：这次是新实例的第一次调用（提示位只消耗一次）。
      assert.equal(next.isFirstResultOnNewInstance, true);
      const second = await table.eval({ sessionId: sid, code: "return 2;", timeoutMs: 10_000 });
      assert.equal(second.isFirstResultOnNewInstance, false);
    } finally {
      table.disposeAll();
    }
  },
);

test(
  "两会话隔离：A 忙时 B 正常完成，console / LocalStorage / 重置互不影响",
  { timeout: 20_000 },
  async () => {
    const table = new SandboxInstanceTable();
    const sidA = session("sess_worker_iso_a");
    const sidB = session("sess_worker_iso_b");
    try {
      await table.eval({
        sessionId: sidA,
        code: 'globalThis.a = "A"; localStorage.setItem("k", "A"); console.log("console-a"); return 1;',
        timeoutMs: 10_000,
      });
      const busyA = table.eval({
        sessionId: sidA,
        code: "const end = Date.now() + 60_000; while (Date.now() < end) {}",
        timeoutMs: 60_000,
      });
      await delay(100);
      const b = await table.eval({
        sessionId: sidB,
        code: 'return (typeof a) + "/" + String(localStorage.getItem("k"));',
        timeoutMs: 10_000,
      });
      assert.equal(b.result.kind, "completed");
      if (b.result.kind !== "completed") return;
      assert.equal(b.result.returnText, "undefined/null");

      await table.reset(sidA);
      await busyA;
      const bAgain = await table.eval({ sessionId: sidB, code: "return 1;", timeoutMs: 10_000 });
      assert.equal(bAgain.result.kind, "completed");
    } finally {
      table.disposeAll();
    }
  },
);

// -----------------------------------------------
// 陈旧 identity：旧 worker / 旧 generation 的消息不得影响新实例
// -----------------------------------------------

class FakeWorker implements SandboxWorkerPort {
  readonly posted: unknown[] = [];
  private readonly listeners = {
    message: [] as Array<(value: unknown) => void>,
    error: [] as Array<(error: Error) => void>,
    exit: [] as Array<(code: number) => void>,
  };

  constructor(
    private readonly identity: { workerId: string; generation: number; sessionId: string },
  ) {}

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  terminate(): Promise<number> {
    return Promise.resolve(0);
  }

  on(event: "message" | "error" | "exit", listener: (...args: never[]) => void): unknown {
    (this.listeners[event] as Array<(...args: never[]) => void>).push(listener);
    return this;
  }

  emitMessage(message: unknown): void {
    for (const listener of this.listeners.message) listener(message);
  }

  lastEvalRequest(): { requestId: number; code: string; mode: string } | undefined {
    return this.posted.find((entry) => (entry as { type?: string }).type === "eval") as
      | { requestId: number; code: string; mode: string }
      | undefined;
  }

  ready(): void {
    this.emitMessage({ ...this.identity, type: "ready" });
  }
}

function fakeIdentity(index: number): { workerId: string; generation: number; sessionId: string } {
  return { workerId: `fake-worker-${index}`, generation: index, sessionId: "sess_fake" };
}

async function createFakeInstance(
  fake: FakeWorker,
  identity: { workerId: string; generation: number; sessionId: string },
): Promise<SandboxInstance> {
  const instance = SandboxInstance.create(undefined, undefined, undefined, undefined, {
    workerId: identity.workerId,
    generation: identity.generation,
    sessionId: identity.sessionId as SessionId,
    workerUrl: new URL("file:///fake/sandbox-worker.cjs"),
    wasmPath: "/fake/quickjs.wasm",
    workerFactory: () => fake,
  });
  fake.ready();
  return instance;
}

test("旧 identity 的延迟回包不写入新实例投影、不结算新请求", { timeout: 10_000 }, async () => {
  const oldIdentity = fakeIdentity(1);
  const oldFake = new FakeWorker(oldIdentity);
  const oldInstance = await createFakeInstance(oldFake, oldIdentity);
  const oldEval = oldInstance.eval("return 1;");
  const oldRequest = oldFake.lastEvalRequest();
  assert.ok(oldRequest);
  oldInstance.dispose();
  assert.equal((await oldEval).result.kind, "failed");

  const newIdentity = fakeIdentity(2);
  const newFake = new FakeWorker(newIdentity);
  const newInstance = await createFakeInstance(newFake, newIdentity);
  try {
    const pending = newInstance.eval("return 'new';");
    const request = newFake.lastEvalRequest();
    assert.ok(request);

    // 旧 worker 的 eval-result / console / local-storage 全部属于旧 identity：
    // 即使被投递到新实例的通道，也不能污染投影或结算。
    newFake.emitMessage({
      ...oldIdentity,
      type: "console",
      method: "log",
      text: "stale-console",
    });
    newFake.emitMessage({
      ...oldIdentity,
      type: "local-storage",
      change: { op: "set", key: "stale", value: "1" },
    });
    newFake.emitMessage({
      ...oldIdentity,
      type: "eval-result",
      requestId: request.requestId,
      alive: true,
      ok: true,
      returnText: "stale-return",
      heapBytes: 1,
    });
    await delay(20);
    assert.equal(newInstance.readConsoleWindow({ filter: "stale-console" }).lines.length, 0);
    assert.equal(newInstance.localStorage.getItem("stale"), null);

    // 正确 identity 的回包才结算。
    newFake.emitMessage({
      ...newIdentity,
      type: "eval-result",
      requestId: request.requestId,
      alive: true,
      ok: true,
      returnText: "fresh-return",
      heapBytes: 123,
    });
    const outcome = await pending;
    assert.equal(outcome.result.kind, "completed");
    if (outcome.result.kind !== "completed") return;
    assert.equal(outcome.result.returnText, "fresh-return");
    assert.equal(newInstance.heapBytes(), 123);
  } finally {
    newInstance.dispose();
  }
});

test(
  "陈旧 generation / 已销毁实例的同步 host-call 也会被结算，不悬挂",
  { timeout: 10_000 },
  async () => {
    const identity = fakeIdentity(41);
    const fake = new FakeWorker(identity);
    const instance = await createFakeInstance(fake, identity);
    try {
      // 陈旧 generation：消息 identity 与当前实例不符，仍须写回错误并唤醒。
      const stale = createSandboxSyncHostCallSignal(1024);
      fake.emitMessage({
        ...fakeIdentity(42),
        type: "host-call",
        requestId: 7,
        op: "fs.readFile",
        args: [{ kind: "string", value: "x" }],
        sync: { buffer: stale.buffer },
      });
      const staleResult = stale.wait(1_000);
      assert.equal(staleResult.ok, false);
      assert.equal(staleResult.error?.code, "SANDBOX_FS_STALE_GENERATION");
    } finally {
      instance.dispose();
    }

    // 已销毁实例：Worker 尚未退出时的同步请求按 sandbox_disposed 结算。
    const disposed = createSandboxSyncHostCallSignal(1024);
    fake.emitMessage({
      ...identity,
      type: "host-call",
      requestId: 8,
      op: "fs.readFile",
      args: [{ kind: "string", value: "x" }],
      sync: { buffer: disposed.buffer },
    });
    const disposedResult = disposed.wait(1_000);
    assert.equal(disposedResult.ok, false);
    assert.equal(disposedResult.error?.code, "sandbox_disposed");
  },
);

test("缺发行资产显式失败，不回退主线程 VM", () => {
  assert.throws(
    () =>
      resolveSandboxWorkerAssets({
        metaUrl: "file:///definitely/missing/zcode.cjs",
        fileExists: () => false,
      }),
    /Sandbox worker (entry|wasm) .*missing|Sandbox worker assets are unavailable/,
  );
});
