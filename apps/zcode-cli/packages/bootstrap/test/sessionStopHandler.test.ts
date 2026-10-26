import assert from "node:assert/strict";
import test from "node:test";
// handlers/index.js 必须先进来：goal-compact → session-flow → prompt-turn → session-residency
// 回到 handlers/index 构成既有循环，先导入 barrel 才能让 handler 表在被 spread 前完成初始化。
import "../src/zcode-protocol-v4/commands/handlers/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";
import {
  preemptActiveTurnAndWait,
  sessionFlowHandlers,
} from "../src/zcode-protocol-v4/commands/handlers/session-flow.js";
import { V4CommandNoopError } from "../src/zcode-protocol-v4/v4-gateway.js";

// docs/specs/stop-success-terminal-arbitration.md
// - 用户 stop 命中已准入成功终态：Core 返回 completed，bootstrap 只能 noop，不得
//   abort legacy controller、pause goal 或 hold queue。
// - 内部抢占（sendQueuedNow / edit-resend）遇到 completed 不能只等 idle：同一 command
//   成功后还会进入 verifier/continuation，必须保留 execution guard，等提交保护释放后
//   继续取消同一个 foreground execution；期间不能误停新 execution。
// - 匹配 / idle / mismatch / stopped 的既有语义保持不变。

const SESSION_ID = "session-stop-handler";

type StopResult =
  | { kind: "stopped"; foregroundExecutionId: string }
  | { kind: "completed"; foregroundExecutionId: string }
  | { kind: "idle" }
  | { kind: "mismatch"; activeForegroundExecutionId: string };

type StopCall = Record<string, unknown>;

interface Harness {
  host: V4CommandCoreHost;
  record: V4SessionRecordView;
  events: string[];
  stopCalls: StopCall[];
  queueLength: number;
  /** 用户 stop 路径捕获的 Bootstrap controller；可能已被 record 释放。 */
  bootstrapController?: AbortController;
  goalStatus: "active" | "paused" | null;
}

interface HarnessOptions {
  stopResults: StopResult[];
  queueLength?: number;
  goalStatus?: "active" | null;
  withBootstrapController?: boolean;
}

function buildHarness(options: HarnessOptions): Harness {
  const state: Harness = {
    events: [],
    stopCalls: [],
    queueLength: options.queueLength ?? 0,
    bootstrapController: options.withBootstrapController ? new AbortController() : undefined,
    goalStatus: options.goalStatus ?? null,
    host: null as unknown as V4CommandCoreHost,
    record: null as unknown as V4SessionRecordView,
  };
  let stopIndex = 0;

  /**
   * Core 的 abort 会让当前 turn 的 finally 释放 Bootstrap controller。
   * 这里用微任务模拟该收尾，避免 waitForSessionIdle 在测试里空转 5s。
   */
  const scheduleControllerRelease = (): void => {
    queueMicrotask(() => {
      const record = state.record as { activeAbortController?: AbortController };
      if (record.activeAbortController === state.bootstrapController) {
        record.activeAbortController = undefined;
      }
    });
  };

  state.record = {
    app: {
      sessionId: SESSION_ID,
      readTarget: async () => (state.goalStatus === null ? null : { status: state.goalStatus }),
      updateTargetStatus: async (status: "active" | "paused") => {
        state.events.push(`pause:${status}`);
        if (state.goalStatus === null) return null;
        state.goalStatus = status;
        return { status };
      },
      setQueueAutoDrain: async (autoDrain: boolean) => {
        state.events.push(`autoDrain:${autoDrain}`);
        return true;
      },
      runtime: {
        stopActiveForegroundExecution: (stopOptions: StopCall) => {
          state.stopCalls.push(stopOptions);
          const result = options.stopResults[stopIndex];
          stopIndex += 1;
          assert.ok(result, "stopActiveForegroundExecution 被调用的次数超出预期");
          state.events.push(`stop:${result.kind}`);
          // stopped/idle 表示这次执行已经结束或即将结束；模拟 turn finally 释放锁。
          // completed 不释放：成功提交保护内执行仍然存在，后续可能进入 verifier。
          if (result.kind === "idle") scheduleControllerRelease();
          if (result.kind === "stopped") scheduleControllerRelease();
          if (result.kind === "mismatch") scheduleControllerRelease();
          return result;
        },
        hasActiveOrQueuedTurnWork: () => false,
      },
    },
    activeAbortController: state.bootstrapController,
    traceContext: { queryId: "query-stop" },
    workspace: { workspacePath: "/tmp/workspace" },
    persistence: "immediate",
  } as unknown as V4SessionRecordView;

  state.host = {
    getRecord: (sessionId: string) => (sessionId === SESSION_ID ? state.record : undefined),
    getQueueLength: (sessionId: string) => (sessionId === SESSION_ID ? state.queueLength : 0),
    afterLegacyStateMutation: async (_record: V4SessionRecordView, reason: string) => {
      state.events.push(`mutation:${reason}`);
    },
  } as unknown as V4CommandCoreHost;

  return state;
}

function stopEnvelope(expectedForegroundExecutionId?: string) {
  return {
    commandId: "cmd-stop-1",
    sessionId: SESSION_ID,
    clientId: "client-1",
    payload: expectedForegroundExecutionId === undefined ? {} : { expectedForegroundExecutionId },
  } as never;
}

async function assertNoop(
  promise: Promise<unknown>,
  reasonCode: string,
): Promise<V4CommandNoopError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof V4CommandNoopError, "必须是 V4CommandNoopError");
    assert.equal(error.reasonCode, reasonCode);
    return error;
  }
  assert.fail("期望 noop，但命令成功返回");
}

test("用户 stop：匹配的成功准入 completed 只返回 noop，不 abort/pause/hold", async () => {
  const h = buildHarness({
    stopResults: [{ kind: "completed", foregroundExecutionId: "fe-1" }],
    queueLength: 1,
    goalStatus: "active",
    withBootstrapController: true,
  });

  await assertNoop(sessionFlowHandlers.stop(h.host, stopEnvelope("fe-1")), "proto.alreadyResolved");

  // stop 只做了裁决查询；成功已提交，不能被 legacy 路径改写成 cancelled。
  assert.deepEqual(
    h.events.filter((event) => event !== "stop:completed"),
    [],
  );
  assert.equal(h.bootstrapController?.signal.aborted, false);
  assert.deepEqual(h.stopCalls, [
    { expectedForegroundExecutionId: "fe-1", reason: "v4 session stopped" },
  ]);
});

test("用户 stop：无 expected id 的旧客户端遇到 completed 同样 noop", async () => {
  const h = buildHarness({
    stopResults: [{ kind: "completed", foregroundExecutionId: "fe-1" }],
    queueLength: 2,
    goalStatus: "active",
    withBootstrapController: true,
  });

  await assertNoop(sessionFlowHandlers.stop(h.host, stopEnvelope()), "proto.alreadyResolved");

  assert.deepEqual(
    h.events.filter((event) => event !== "stop:completed"),
    [],
  );
  assert.equal(h.bootstrapController?.signal.aborted, false);
  assert.deepEqual(h.stopCalls, [
    { expectedForegroundExecutionId: undefined, reason: "v4 session stopped" },
  ]);
});

for (const result of [
  { kind: "idle" },
  { kind: "mismatch", activeForegroundExecutionId: "fe-new" },
] as const) {
  test(`用户 stop：stale expected id（${result.kind}）noop，不取消新执行`, async () => {
    const h = buildHarness({
      stopResults: [result],
      queueLength: 1,
      goalStatus: "active",
      withBootstrapController: true,
    });

    await assertNoop(
      sessionFlowHandlers.stop(h.host, stopEnvelope("fe-old")),
      "guard.stopTargetChanged",
    );

    assert.deepEqual(
      h.events.filter((event) => event !== `stop:${result.kind}`),
      [],
    );
    assert.equal(h.bootstrapController?.signal.aborted, false);
    // 传给 runtime 的是旧 id；mismatch 由 Core 判定，bootstrap 不得改用新 id 再停。
    assert.equal(h.stopCalls.length, 1);
    assert.equal(h.stopCalls[0]?.expectedForegroundExecutionId, "fe-old");
  });
}

test("用户 stop：stopped 且队列非空 → abort、hold queue、暂停 goal", async () => {
  const h = buildHarness({
    stopResults: [{ kind: "stopped", foregroundExecutionId: "fe-1" }],
    queueLength: 1,
    goalStatus: "active",
    withBootstrapController: true,
  });

  const result = await sessionFlowHandlers.stop(h.host, stopEnvelope("fe-1"));
  assert.equal(result, undefined);
  assert.equal(h.bootstrapController?.signal.aborted, true);
  assert.deepEqual(h.events, [
    "stop:stopped",
    "autoDrain:false",
    "pause:paused",
    "mutation:session_stop_goal_paused",
  ]);
});

test("用户 stop：stopped 但队列为空且无 active goal → 不写 autoDrain/pause", async () => {
  const h = buildHarness({
    stopResults: [{ kind: "stopped", foregroundExecutionId: "fe-1" }],
    queueLength: 0,
    goalStatus: null,
    withBootstrapController: true,
  });

  const result = await sessionFlowHandlers.stop(h.host, stopEnvelope("fe-1"));
  assert.equal(result, undefined);
  assert.equal(h.bootstrapController?.signal.aborted, true);
  assert.deepEqual(h.events, ["stop:stopped"]);
});

test("内部抢占：completed 等提交保护释放后继续取消同一个 execution", async () => {
  const h = buildHarness({
    stopResults: [
      { kind: "completed", foregroundExecutionId: "fe-1" },
      { kind: "completed", foregroundExecutionId: "fe-1" },
      { kind: "stopped", foregroundExecutionId: "fe-1" },
    ],
    goalStatus: "active",
    withBootstrapController: true,
  });

  const stopped = await preemptActiveTurnAndWait(h.host, h.record, {
    abortMessage: "v4 sendQueuedNow preempted current turn",
    goalPausedMutationReason: "send_queued_now_goal_paused",
    preserveQueueAutoDrainOnCancel: true,
    waitExcludeForegroundPromotionLeaseId: "send-now:cmd-1",
  });

  assert.equal(stopped, true);
  assert.equal(h.stopCalls.length, 3);
  // 首次抢占不知道 execution id；completed 之后必须绑定同一个 id 重试，直到真正取消。
  assert.deepEqual(h.stopCalls[0], {
    preserveQueueAutoDrainOnCancel: true,
    reason: "v4 sendQueuedNow preempted current turn",
  });
  assert.deepEqual(h.stopCalls[1], {
    expectedForegroundExecutionId: "fe-1",
    preserveQueueAutoDrainOnCancel: true,
    reason: "v4 sendQueuedNow preempted current turn",
  });
  assert.deepEqual(h.stopCalls[2], h.stopCalls[1]);
  // 内部抢占只暂停 goal，不关闭队列授权；completed 期间也不能 abort legacy controller。
  // pause 必须发生在同一个 execution 真正 stopped 之后，不能提前改变 goal 状态。
  assert.deepEqual(h.events, [
    "stop:completed",
    "stop:completed",
    "stop:stopped",
    "pause:paused",
    "mutation:send_queued_now_goal_paused",
  ]);
  assert.equal(h.bootstrapController?.signal.aborted, false);
});

test("内部抢占：completed 后保护释放时已 idle → 不再取消，不 abort/pause", async () => {
  const h = buildHarness({
    stopResults: [{ kind: "completed", foregroundExecutionId: "fe-1" }, { kind: "idle" }],
    goalStatus: "active",
    withBootstrapController: true,
  });

  const stopped = await preemptActiveTurnAndWait(h.host, h.record, {
    abortMessage: "preempt",
    goalPausedMutationReason: "preempt_goal_paused",
    preserveQueueAutoDrainOnCancel: true,
  });

  assert.equal(stopped, false);
  assert.equal(h.stopCalls.length, 2);
  assert.equal(h.stopCalls[1]?.expectedForegroundExecutionId, "fe-1");
  assert.deepEqual(
    h.events.filter((event) => event !== "stop:completed" && event !== "stop:idle"),
    [],
  );
  // 成功提交后已经结束：legacy controller 不得被晚到抢占误 abort。
  assert.equal(h.bootstrapController?.signal.aborted, false);
});

test("内部抢占：completed 后出现新 execution（mismatch）→ 不误停、不 abort/pause", async () => {
  const h = buildHarness({
    stopResults: [
      { kind: "completed", foregroundExecutionId: "fe-old" },
      { kind: "mismatch", activeForegroundExecutionId: "fe-new" },
    ],
    goalStatus: "active",
    withBootstrapController: true,
  });

  const stopped = await preemptActiveTurnAndWait(h.host, h.record, {
    abortMessage: "preempt",
    goalPausedMutationReason: "preempt_goal_paused",
    preserveQueueAutoDrainOnCancel: true,
  });

  assert.equal(stopped, false);
  assert.equal(h.stopCalls.length, 2);
  // 重试必须继续指向旧 execution，mismatch 说明新 execution 已接手，不能改用新 id。
  assert.equal(h.stopCalls[1]?.expectedForegroundExecutionId, "fe-old");
  assert.deepEqual(
    h.events.filter((event) => event !== "stop:completed" && event !== "stop:mismatch"),
    [],
  );
  assert.equal(h.bootstrapController?.signal.aborted, false);
});

test("内部抢占：completed 后重试沿用 preserve=false，不擅自改写队列授权", async () => {
  const h = buildHarness({
    stopResults: [
      { kind: "completed", foregroundExecutionId: "fe-1" },
      { kind: "stopped", foregroundExecutionId: "fe-1" },
    ],
    goalStatus: "active",
  });

  const stopped = await preemptActiveTurnAndWait(h.host, h.record, {
    abortMessage: "preempt without preserve",
    goalPausedMutationReason: "preempt_goal_paused",
  });

  assert.equal(stopped, true);
  assert.deepEqual(h.stopCalls, [
    { preserveQueueAutoDrainOnCancel: false, reason: "preempt without preserve" },
    {
      expectedForegroundExecutionId: "fe-1",
      preserveQueueAutoDrainOnCancel: false,
      reason: "preempt without preserve",
    },
  ]);
});

test("内部抢占：直接 stopped 仍保留 preserve 并暂停 goal（回归）", async () => {
  const h = buildHarness({
    stopResults: [{ kind: "stopped", foregroundExecutionId: "fe-1" }],
    goalStatus: "active",
  });

  const stopped = await preemptActiveTurnAndWait(h.host, h.record, {
    abortMessage: "preempt",
    goalPausedMutationReason: "preempt_goal_paused",
    preserveQueueAutoDrainOnCancel: true,
  });

  assert.equal(stopped, true);
  assert.equal(h.stopCalls.length, 1);
  assert.deepEqual(h.stopCalls[0], {
    preserveQueueAutoDrainOnCancel: true,
    reason: "preempt",
  });
  assert.deepEqual(
    h.events.filter((event) => event !== "stop:stopped"),
    ["pause:paused", "mutation:preempt_goal_paused"],
  );
});
