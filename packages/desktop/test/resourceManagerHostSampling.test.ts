import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  HostMessageTypes,
  hostResourceUsageSnapshotResultResponseSchema,
  type HostResourceUsageProcess,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";
import {
  forgetHostResourceUsage,
  requestHostResourceUsage,
  resolveHostResourceUsageResult,
} from "../src/main/resourceManagerHostSampling.js";

/**
 * 资源管理器 main → Host 采样生命周期
 * （docs/specs/resource-manager-process-sampling.md）。
 *
 * 展示等待与底层采样分离：900ms 只决定本轮快照显示 pending/stale，
 * 迟到回帖仍更新缓存；底层有独立完成期限，丢响应后取消释放，下一轮可重试。
 * 同一 Host 最多一个在途请求，取消或旧 requestId 不得写回新生命周期。
 * 超时边界统一使用 node:test mock timers，避免小毫秒数在 CI 上抖动。
 */

interface PostedMessage {
  type: string;
  requestId: string;
}

function useTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout"] });
}

function createChild(): {
  child: { postMessage: (message: PostedMessage) => void };
  posted: PostedMessage[];
} {
  const posted: PostedMessage[] = [];
  return {
    posted,
    child: {
      postMessage: (message) => {
        posted.push(message);
      },
    },
  };
}

function requestMessages(posted: PostedMessage[]): PostedMessage[] {
  return posted.filter((message) => message.type === HostMessageTypes.ResourceUsageSnapshotRequest);
}

function cancelMessages(posted: PostedMessage[]): PostedMessage[] {
  return posted.filter((message) => message.type === HostMessageTypes.ResourceUsageSnapshotCancel);
}

function row(pid: number): HostResourceUsageProcess {
  return {
    pid,
    name: "node",
    category: "base",
    groupKey: "cli",
    groupLabel: "cli",
    cpuPercent: 1,
    memoryBytes: 1024,
  };
}

function complete(
  requestId: string,
  rows: HostResourceUsageProcess[] = [row(300)],
): HostResourceUsageSnapshotResultResponse {
  return hostResourceUsageSnapshotResultResponseSchema.parse({
    type: "resource-usage-snapshot-result",
    requestId,
    sampledAt: 1,
    processes: rows,
  });
}

function failed(requestId: string): HostResourceUsageSnapshotResultResponse {
  return hostResourceUsageSnapshotResultResponseSchema.parse({
    type: "resource-usage-snapshot-result",
    requestId,
    sampledAt: 1,
    processes: [],
    samplingStatus: "failed",
  });
}

test("完整回帖通过真实 strict schema 并返回 complete", async (t) => {
  useTimers(t);
  const label = "host-complete";
  const { child, posted } = createChild();
  const promise = requestHostResourceUsage(label, child, 100);

  assert.equal(requestMessages(posted).length, 1);
  const requestId = requestMessages(posted)[0]!.requestId;
  const reply = hostResourceUsageSnapshotResultResponseSchema.parse({
    type: "resource-usage-snapshot-result",
    requestId,
    sampledAt: 1,
    processes: [{ ...row(300), sessionId: "sess-1", sessionTitle: "修复采样" }],
  });
  resolveHostResourceUsageResult(label, reply);

  const result = await promise;
  assert.equal(result.samplingStatus, "complete");
  assert.equal(result.processes[0]?.sessionId, "sess-1");
  forgetHostResourceUsage(label);
});

test("每轮都晚于展示等待时，迟到成功由下一轮 poll 以 complete 消费", async (t) => {
  useTimers(t);
  const label = "host-slow-rounds";
  const { child, posted } = createChild();

  // 第一轮：Windows 采样慢于 900ms，展示等待先返回 pending。
  const firstPromise = requestHostResourceUsage(label, child, 10, undefined, 1_000);
  t.mock.timers.tick(10);
  const first = await firstPromise;
  assert.deepEqual(first, { processes: [], samplingStatus: "pending" });
  const firstId = requestMessages(posted)[0]!.requestId;
  resolveHostResourceUsageResult(label, complete(firstId, [row(310)]));

  // 第二轮：上一轮迟到成功必须作为新鲜 complete 交付，并在同一 poll 启动下一轮。
  const second = await requestHostResourceUsage(label, child, 10, undefined, 1_000);
  assert.equal(second.samplingStatus, "complete");
  assert.deepEqual(second.processes, [row(310)]);
  assert.equal(requestMessages(posted).length, 2, "消费 fresh 后启动且只启动一轮新采样");

  // 第三轮：fresh 已消费，底层仍在途，只能 stale；不能重复发起采样。
  const thirdPromise = requestHostResourceUsage(label, child, 10, undefined, 1_000);
  t.mock.timers.tick(10);
  const third = await thirdPromise;
  assert.equal(third.samplingStatus, "stale");
  assert.deepEqual(third.processes, [row(310)]);
  assert.equal(requestMessages(posted).length, 2, "在途期间不重复发起采样");

  // 第二轮采样同样迟到成功，下一轮 poll 再次以 fresh complete 消费。
  resolveHostResourceUsageResult(
    label,
    complete(requestMessages(posted)[1]!.requestId, [row(311)]),
  );
  const fourth = await requestHostResourceUsage(label, child, 10, undefined, 1_000);
  assert.equal(fourth.samplingStatus, "complete");
  assert.deepEqual(fourth.processes, [row(311)]);
  assert.equal(requestMessages(posted).length, 3);
  forgetHostResourceUsage(label);
});

test("失败回帖不产生 fresh，且没有成功缓存时下一轮只能是 pending", async (t) => {
  useTimers(t);
  const label = "host-failed";
  const { child, posted } = createChild();
  const first = requestHostResourceUsage(label, child, 100);
  resolveHostResourceUsageResult(label, failed(requestMessages(posted)[0]!.requestId));

  assert.deepEqual(await first, { processes: [], samplingStatus: "failed" });

  const nextPromise = requestHostResourceUsage(label, child, 15, undefined, 1_000);
  t.mock.timers.tick(15);
  const next = await nextPromise;
  assert.equal(next.samplingStatus, "pending");
  assert.deepEqual(next.processes, []);
  forgetHostResourceUsage(label);
});

test("失败后不能把先前的 complete 当作新鲜结果", async (t) => {
  useTimers(t);
  const label = "host-failed-after-complete";
  const { child, posted } = createChild();

  const first = requestHostResourceUsage(label, child, 100);
  resolveHostResourceUsageResult(
    label,
    complete(requestMessages(posted)[0]!.requestId, [row(320)]),
  );
  assert.equal((await first).samplingStatus, "complete");

  const second = requestHostResourceUsage(label, child, 100);
  resolveHostResourceUsageResult(label, failed(requestMessages(posted)[1]!.requestId));
  assert.equal((await second).samplingStatus, "failed");

  // 失败清掉 fresh；旧 complete 只能以 stale 回退，不能再次冒充新鲜完整结果。
  const thirdPromise = requestHostResourceUsage(label, child, 15, undefined, 1_000);
  t.mock.timers.tick(15);
  const third = await thirdPromise;
  assert.equal(third.samplingStatus, "stale");
  assert.deepEqual(third.processes, [row(320)]);
  forgetHostResourceUsage(label);
});

test("旧成功缓存超时回退为 stale，不冒充本轮 complete", async (t) => {
  useTimers(t);
  const label = "host-stale";
  const { child, posted } = createChild();
  const first = requestHostResourceUsage(label, child, 100);
  resolveHostResourceUsageResult(
    label,
    complete(requestMessages(posted)[0]!.requestId, [row(302)]),
  );
  assert.equal((await first).samplingStatus, "complete");

  const secondPromise = requestHostResourceUsage(label, child, 15, undefined, 1_000);
  t.mock.timers.tick(15);
  const second = await secondPromise;
  assert.equal(second.samplingStatus, "stale");
  assert.deepEqual(second.processes, [row(302)]);
  forgetHostResourceUsage(label);
});

test("同一 Host 在途期间不重复发起采样，也不按 UI 节奏排队", async (t) => {
  useTimers(t);
  const label = "host-inflight";
  const { child, posted } = createChild();
  const first = requestHostResourceUsage(label, child, 20, undefined, 1_000);
  const second = requestHostResourceUsage(label, child, 20, undefined, 1_000);

  assert.equal(requestMessages(posted).length, 1, "并发刷新只能复用同一个底层请求");
  t.mock.timers.tick(20);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.samplingStatus, "pending");
  assert.equal(secondResult.samplingStatus, "pending");
  forgetHostResourceUsage(label);
});

test("底层丢响应超过完成期限后取消释放，下一轮可以重试", async (t) => {
  useTimers(t);
  const label = "host-deadline";
  const { child, posted } = createChild();
  const firstPromise = requestHostResourceUsage(label, child, 10, undefined, 40);
  t.mock.timers.tick(10);
  const first = await firstPromise;
  assert.equal(first.samplingStatus, "pending");

  t.mock.timers.tick(30);
  assert.equal(cancelMessages(posted).length, 1, "完成期限到点后必须向 Host 发取消");
  assert.equal(requestMessages(posted).length, 1);

  const retryPromise = requestHostResourceUsage(label, child, 10, undefined, 40);
  assert.equal(requestMessages(posted).length, 2, "释放后下一次刷新可以重新采样");
  t.mock.timers.tick(10);
  const retry = await retryPromise;
  assert.equal(retry.samplingStatus, "pending");
  forgetHostResourceUsage(label);
});

test("beginSampling 同步 postMessage 失败返回 failed，且下一轮可重试", async (t) => {
  useTimers(t);
  const label = "host-post-failed";
  const brokenPosted: PostedMessage[] = [];
  const broken = {
    postMessage: (message: PostedMessage): void => {
      brokenPosted.push(message);
      throw new Error("host exited");
    },
  };

  const first = await requestHostResourceUsage(label, broken, 10, undefined, 100);
  assert.equal(first.samplingStatus, "failed");
  assert.deepEqual(first.processes, []);
  assert.equal(requestMessages(brokenPosted).length, 1);

  const { child, posted } = createChild();
  const retryPromise = requestHostResourceUsage(label, child, 10, undefined, 100);
  assert.equal(requestMessages(posted).length, 1, "失败请求释放后下一轮重新采样");
  resolveHostResourceUsageResult(
    label,
    complete(requestMessages(posted)[0]!.requestId, [row(330)]),
  );
  const retry = await retryPromise;
  assert.equal(retry.samplingStatus, "complete");
  assert.deepEqual(retry.processes, [row(330)]);
  forgetHostResourceUsage(label);
});

test("消费 fresh 时新请求发送失败不能报 complete，fresh 留待下次消费", async (t) => {
  useTimers(t);
  const label = "host-fresh-start-failed";
  const { child, posted } = createChild();

  const firstPromise = requestHostResourceUsage(label, child, 10, undefined, 1_000);
  t.mock.timers.tick(10);
  await firstPromise;
  resolveHostResourceUsageResult(
    label,
    complete(requestMessages(posted)[0]!.requestId, [row(340)]),
  );

  const brokenPosted: PostedMessage[] = [];
  const broken = {
    postMessage: (message: PostedMessage): void => {
      brokenPosted.push(message);
      throw new Error("host exited");
    },
  };
  const failedStart = await requestHostResourceUsage(label, broken, 10, undefined, 100);
  assert.equal(
    failedStart.samplingStatus,
    "failed",
    "新请求发不出去时不能把旧 fresh 报成 complete",
  );
  assert.deepEqual(failedStart.processes, []);
  assert.equal(requestMessages(brokenPosted).length, 1);

  // fresh 没有被消费掉；恢复可用 Host 后下一轮仍能拿到 complete 并启动新采样。
  const { child: recoveredChild, posted: recoveredPosted } = createChild();
  const recovered = await requestHostResourceUsage(label, recoveredChild, 10, undefined, 1_000);
  assert.equal(recovered.samplingStatus, "complete");
  assert.deepEqual(recovered.processes, [row(340)]);
  assert.equal(requestMessages(recoveredPosted).length, 1);
  forgetHostResourceUsage(label);
});

test("abort 取消在途请求，并在展示超时后仍然生效", async (t) => {
  useTimers(t);
  const label = "host-abort";
  const { child, posted } = createChild();
  const controller = new AbortController();
  const firstPromise = requestHostResourceUsage(label, child, 10, controller.signal, 1_000);
  t.mock.timers.tick(10);
  const first = await firstPromise;
  assert.equal(first.samplingStatus, "pending");

  // 展示等待已结束，abort 仍要取消底层请求并清缓存。
  controller.abort();
  assert.equal(cancelMessages(posted).length, 1);

  const nextPromise = requestHostResourceUsage(label, child, 10, undefined, 1_000);
  assert.equal(requestMessages(posted).length, 2);
  t.mock.timers.tick(10);
  const next = await nextPromise;
  assert.equal(next.samplingStatus, "pending");
  forgetHostResourceUsage(label);
});

test("在途请求首次没有 signal 时，后到调用携带的 abort 仍能取消", async (t) => {
  useTimers(t);
  const label = "host-abort-late-signal";
  const { child, posted } = createChild();

  const first = requestHostResourceUsage(label, child, 1_000, undefined, 5_000);
  const controller = new AbortController();
  const second = requestHostResourceUsage(label, child, 1_000, controller.signal, 5_000);
  assert.equal(requestMessages(posted).length, 1, "后到调用复用同一在途请求");

  controller.abort();
  assert.equal(cancelMessages(posted).length, 1, "后挂载的 signal 必须能取消在途请求");
  assert.equal((await second).samplingStatus, "failed");
  assert.equal((await first).samplingStatus, "failed");
  forgetHostResourceUsage(label);
});

test("取消后的旧 requestId 回帖不得写入新生命周期", async (t) => {
  useTimers(t);
  const label = "host-isolation";
  const { child, posted } = createChild();
  const controller = new AbortController();
  const firstPromise = requestHostResourceUsage(label, child, 10, controller.signal, 1_000);
  t.mock.timers.tick(10);
  await firstPromise;
  const oldRequestId = requestMessages(posted)[0]!.requestId;
  controller.abort();

  const secondPromise = requestHostResourceUsage(label, child, 15, undefined, 1_000);
  const newRequestId = requestMessages(posted)[1]!.requestId;
  // 旧回帖即使带完整进程表也必须被忽略。
  resolveHostResourceUsageResult(label, complete(oldRequestId, [row(999)]));

  t.mock.timers.tick(15);
  const stale = await secondPromise;
  assert.equal(stale.samplingStatus, "pending");
  assert.deepEqual(stale.processes, []);

  resolveHostResourceUsageResult(label, complete(newRequestId, [row(303)]));
  const third = await requestHostResourceUsage(label, child, 10, undefined, 1_000);
  assert.equal(third.samplingStatus, "complete");
  assert.deepEqual(third.processes, [row(303)]);
  assert.equal(requestMessages(posted).length, 3, "消费 fresh 时启动新一轮");

  const fourthPromise = requestHostResourceUsage(label, child, 10, undefined, 1_000);
  t.mock.timers.tick(10);
  const fourth = await fourthPromise;
  assert.equal(fourth.samplingStatus, "stale");
  assert.deepEqual(fourth.processes, [row(303)]);
  assert.equal(requestMessages(posted).length, 3, "新一轮仍在途，不重复采样");
  forgetHostResourceUsage(label);
});

test("回帖必须匹配 Host，错 Host 的 requestId 被忽略", async (t) => {
  useTimers(t);
  const label = "host-match";
  const { child, posted } = createChild();
  const promise = requestHostResourceUsage(label, child, 15, undefined, 1_000);
  const requestId = requestMessages(posted)[0]!.requestId;

  resolveHostResourceUsageResult("other-host", complete(requestId, [row(304)]));

  t.mock.timers.tick(15);
  const result = await promise;
  assert.equal(result.samplingStatus, "pending");
  forgetHostResourceUsage(label);
});
