import assert from "node:assert/strict";
import test from "node:test";
// handlers/index.js 必须先进来：goal-compact → session-flow → prompt-turn → session-residency
// 回到 handlers/index 构成既有循环，先导入 barrel 才能让 handler 表在被 spread 前完成初始化。
import "../src/zcode-protocol-v4/commands/handlers/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";
import { forkEditRetryHandlers } from "../src/zcode-protocol-v4/commands/handlers/fork-edit-retry.js";
import { V4InputAdmissionRejectedError } from "../src/zcode-protocol-v4/commands/handlers/session-flow.js";

const { editUserQuery } = forkEditRetryHandlers;

// specs/message-history-edit.md 规则 18（2026-10-07 修订）：运行中编辑重发的内部抢占
// 语义——内部抢占 ≠ 用户 Stop，必须保留队列 autoDrain（preserveQueueAutoDrainOnCancel）；
// 重发输入以 promotion lease 占住空闲位 + requireIdle 直接启动，不落入队列；
// 静态编辑（无运行中 turn）不取 lease、不抢占，行为与既有语义一致。

const SESSION_ID = "edit-preempt-resend";

interface Harness {
  host: V4CommandCoreHost;
  record: V4SessionRecordView;
  events: string[];
  stopCalls: Array<Record<string, unknown>>;
  busyPredicateCalls: Array<Record<string, unknown>>;
  sendInputCalls: Array<{ input: unknown; options: Record<string, unknown> | undefined }>;
  leaseAcquired: boolean;
  leaseReleased: boolean;
  rewound: boolean;
  /** busyPredicate 持续返回 true 的次数（模拟旧 turn 收尾尾巴）。 */
  busyTailCalls: number;
}

function buildHarness(
  options: {
    /** "core-execution"：仅 Core 自持前台执行（model-only 轮）；"abort-controller"：Bootstrap controller。 */
    busy?: "core-execution" | "abort-controller";
    leaseConflict?: boolean;
    busyTailPolls?: number;
  } = {},
): Harness {
  const state: Harness = {
    events: [],
    stopCalls: [],
    busyPredicateCalls: [],
    sendInputCalls: [],
    leaseAcquired: false,
    leaseReleased: false,
    rewound: false,
    busyTailCalls: 0,
    record: null as unknown as V4SessionRecordView,
    host: null as unknown as V4CommandCoreHost,
  };
  let foregroundExecutionId = options.busy === "core-execution" ? "fe-model-only-1" : undefined;
  const busyTail = options.busyTailPolls ?? 0;
  state.record = {
    app: {
      sessionId: SESSION_ID,
      getMode: () => "yolo",
      getModel: () => "openai/gpt-5",
      readTarget: async () => null,
      updateTargetStatus: async () => null,
      sendInput: async (input: unknown, sendOptions: Record<string, unknown>) => {
        state.events.push("sendInput");
        state.sendInputCalls.push({ input, options: sendOptions });
        return {
          kind: "started_turn",
          turnId: "turn-new-1",
          completion: Promise.resolve(),
        };
      },
      runtime: {
        getActiveForegroundExecutionId: () => foregroundExecutionId,
        stopActiveForegroundExecution: (stopOptions: Record<string, unknown>) => {
          state.events.push("stop");
          state.stopCalls.push(stopOptions);
          foregroundExecutionId = undefined;
          // 模拟被中止 turn 的 finally 清理：Bootstrap controller 随收尾释放。
          const recordWithAbort = state.record as { activeAbortController?: unknown };
          recordWithAbort.activeAbortController = undefined;
          return { kind: "stopped", foregroundExecutionId: "fe-model-only-1" };
        },
        hasActiveOrQueuedTurnWork: (predicateOptions: Record<string, unknown>) => {
          state.busyPredicateCalls.push(predicateOptions);
          if (state.busyTailCalls < busyTail) {
            state.busyTailCalls += 1;
            return true;
          }
          return false;
        },
        acquireForegroundPromotionLease: (leaseOptions: { leaseId: string }) => {
          if (options.leaseConflict) {
            return { kind: "conflict", leaseId: "send-now:other-command" } as const;
          }
          state.events.push(`lease:acquire:${leaseOptions.leaseId}`);
          state.leaseAcquired = true;
          return { kind: "acquired", leaseId: leaseOptions.leaseId } as const;
        },
        releaseForegroundPromotionLease: (leaseId: string) => {
          state.events.push(`lease:release:${leaseId}`);
          state.leaseReleased = true;
          return true;
        },
        rewindConversationToMessage: async () => {
          state.rewound = true;
          state.events.push("rewind");
          // RewindStrategy.ActiveChain 的枚举值（contracts/src/rewind）。
          return { strategy: "active_chain" };
        },
      },
    },
    traceContext: { queryId: "query-1" },
    workspace: { workspacePath: "/tmp/workspace" },
    persistence: "immediate",
    ...(options.busy === "abort-controller"
      ? { activeAbortController: new AbortController() }
      : {}),
  } as unknown as V4SessionRecordView;
  state.host = {
    getRecord: (sessionId: string) => (sessionId === SESSION_ID ? state.record : undefined),
    ensureModelReady: async () => {},
    resolveRowActionTarget: () => ({
      ok: true,
      action: "editUserQuery",
      messageId: "msg-assistant-1",
      editTarget: {
        entityId: "entity-1",
        productTurnId: "turn-1",
        transcriptMessageId: "msg-user-1",
        coveredByStableCompact: false,
        intent: {
          kind: "sendText",
          text: "原始问题",
          sourceCommandId: "cmd-origin",
          clientId: "client-1",
        },
      },
      row: { rowId: 1, entityId: "entity-1", turnId: "turn-1" },
    }),
    cancelInputCommand: async () => {},
    afterLegacyStateMutation: async () => {},
  } as unknown as V4CommandCoreHost;
  return state;
}

function editEnvelope(payload: Record<string, unknown>) {
  return {
    commandId: "cmd-edit-1",
    sessionId: SESSION_ID,
    clientId: "client-1",
    payload: { target: { rowId: 1, entityId: "entity-1" }, workspaceMode: "preserve", ...payload },
  } as never;
}

test("运行中编辑（Core 自持执行）：抢占带 preserve、lease 先取后释、重发带 requireIdle 直接启动", async () => {
  const h = buildHarness({ busy: "core-execution" });
  const result = await editUserQuery(h.host, editEnvelope({ newText: "修改后的问题" }));
  assert.deepEqual(result, { type: "editUserQuery", disposition: "rewind", sessionId: SESSION_ID });
  // 内部抢占 ≠ 用户 Stop：cancelled 收口不得关掉队列 autoDrain。
  assert.equal(h.stopCalls.length, 1);
  assert.equal(h.stopCalls[0]?.preserveQueueAutoDrainOnCancel, true);
  // lease 在抢占前取得、命令收尾释放，id 是 edit-resend:<commandId>。
  assert.ok(h.leaseAcquired);
  assert.ok(h.leaseReleased);
  assert.ok(h.events.includes("lease:acquire:edit-resend:cmd-edit-1"));
  assert.ok(h.events.includes("lease:release:edit-resend:cmd-edit-1"));
  const leaseIndex = h.events.findIndex((event) => event.startsWith("lease:acquire"));
  const stopIndex = h.events.indexOf("stop");
  assert.ok(leaseIndex !== -1 && stopIndex !== -1 && leaseIndex < stopIndex);
  // idle 轮询排除自己持有的 lease。
  assert.ok(h.busyPredicateCalls.length > 0);
  assert.deepEqual(h.busyPredicateCalls[0], {
    excludeForegroundPromotionLeaseId: "edit-resend:cmd-edit-1",
  });
  // 重发输入直接启动（started）而非入队，且带 requireIdle 占空闲位。
  assert.equal(h.sendInputCalls.length, 1);
  assert.equal(h.sendInputCalls[0]?.options?.requireIdle, true);
  // 事件顺序：lease → 抢占 → rewind → 重发。
  assert.deepEqual(
    h.events.filter((event) => event !== "sendInput" || true),
    [
      "lease:acquire:edit-resend:cmd-edit-1",
      "stop",
      "rewind",
      "sendInput",
      "lease:release:edit-resend:cmd-edit-1",
    ],
  );
});

test("idle 轮询等待 busy 尾巴（drain/队列残留）消散后才重发", async () => {
  const h = buildHarness({ busy: "core-execution", busyTailPolls: 3 });
  const result = await editUserQuery(h.host, editEnvelope({ newText: "修改后的问题" }));
  assert.deepEqual(result, { type: "editUserQuery", disposition: "rewind", sessionId: SESSION_ID });
  // 3 次 busy 尾巴各轮询一次（25ms 间隔）+ 收尾一次，期间不放弃也不入队。
  assert.ok(h.busyPredicateCalls.length >= 3);
  assert.equal(h.sendInputCalls.length, 1);
  assert.equal(h.sendInputCalls[0]?.options?.requireIdle, true);
});

test("Bootstrap controller busy：同样走 lease + preserve 抢占", async () => {
  const h = buildHarness({ busy: "abort-controller" });
  const result = await editUserQuery(h.host, editEnvelope({ newText: "修改后的问题" }));
  assert.deepEqual(result, { type: "editUserQuery", disposition: "rewind", sessionId: SESSION_ID });
  assert.equal(h.stopCalls.length, 1);
  assert.equal(h.stopCalls[0]?.preserveQueueAutoDrainOnCancel, true);
  assert.ok(h.leaseAcquired && h.leaseReleased);
  assert.equal(h.sendInputCalls[0]?.options?.requireIdle, true);
});

test("lease 冲突：rewind 之前拒绝，不留半程状态", async () => {
  const h = buildHarness({ busy: "core-execution", leaseConflict: true });
  await assert.rejects(
    () => editUserQuery(h.host, editEnvelope({ newText: "修改后的问题" })),
    V4InputAdmissionRejectedError,
  );
  assert.equal(h.rewound, false);
  assert.equal(h.stopCalls.length, 0);
  assert.equal(h.leaseAcquired, false);
  assert.equal(h.leaseReleased, false);
  assert.deepEqual(h.sendInputCalls, []);
});

test("静态编辑（无运行中 turn）：不取 lease、不抢占、重发不带 requireIdle", async () => {
  const h = buildHarness();
  const result = await editUserQuery(h.host, editEnvelope({ newText: "修改后的问题" }));
  assert.deepEqual(result, { type: "editUserQuery", disposition: "rewind", sessionId: SESSION_ID });
  assert.deepEqual(h.stopCalls, []);
  assert.deepEqual(h.busyPredicateCalls, []);
  assert.equal(h.leaseAcquired, false);
  assert.equal(h.rewound, true);
  assert.equal(h.sendInputCalls.length, 1);
  assert.equal(h.sendInputCalls[0]?.options?.requireIdle, undefined);
});
