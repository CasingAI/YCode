// Plan 拒绝 + 回合终态在「会话列表摘要」这条链上的收口验收：
// ConversationSnapshot → SessionsIndexProjection 派生 → 在线帧。
// conversation 层的 pending/phase 由 productProjectionLifecycle.test.ts 保证，
// 这里保证派生与投递不会把终态或 pending 变化吞掉（spec 验收场景 2）。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { SessionSummary, SessionsIndexTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { SessionsIndexProjection } from "../src/zcode-protocol-v4/sessions-index-projection.js";
import { SessionsIndexPublisher } from "../src/zcode-protocol-v4/sessions-index-publisher.js";

const WORKSPACE_ID = "/repo";
const SESSION_ID = "session-index-plan-lifecycle";
const TURN_ID = "turn-index-plan-lifecycle";
const TOOL_CALL_ID = "call-exit-plan";
const REQUEST_ID = "request-plan-approval";
const T0 = 1_700_000_000_000;

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-index-plan-lifecycle",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

/** 取在线帧里该会话的 summary；deltas 帧取最后一条 upsert，snapshot 帧直接取。 */
function summaryOf(frame: SessionsIndexTopicFrame): SessionSummary | undefined {
  if (frame.payload.kind === "snapshot") {
    return frame.payload.snapshot.sessions.find((s) => s.sessionId === SESSION_ID);
  }
  const upserts = frame.payload.deltas.filter(
    (delta): delta is Extract<typeof delta, { op: "session.upserted" }> =>
      delta.op === "session.upserted" && delta.session.sessionId === SESSION_ID,
  );
  return upserts.at(-1)?.session;
}

test("Plan 拒绝与回合终态在 sessions-index 在线帧上一起收口", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  const publisher = new SessionsIndexPublisher(WORKSPACE_ID, "index-epoch", () => T0);
  const subscribed = publisher.subscribeReserved("connection-1");
  assert.equal(subscribed.reservation?.commit(), true);
  const subscriptionId = subscribed.subscriptionId;

  const ingest = (lastActivityAt: number): boolean =>
    publisher.ingestConversation(projection.getSnapshot(), {
      createdAt: T0,
      lastActivityAt,
    });

  projection.applyEvent(
    event(SessionEventType.TurnStarted, { turnNumber: 1, input: "写计划", executionKind: "agent" }, 0),
  );
  projection.applyEvent(
    event(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: TOOL_CALL_ID,
        assistantMessageId: "assistant-1",
        toolName: "ExitPlanMode",
        input: { overview: "概述", plan: "# 计划", title: "计划" },
        schedule: { parallelGroups: [[TOOL_CALL_ID]], executionOrder: [TOOL_CALL_ID] },
      },
      1_000,
    ),
  );
  projection.applyEvent(
    event(
      SessionEventType.PermissionRequested,
      {
        requestId: REQUEST_ID,
        toolCallId: TOOL_CALL_ID,
        toolName: "ExitPlanMode",
        reason: "计划已生成",
        input: { overview: "概述", plan: "# 计划", title: "计划" },
      },
      2_000,
    ),
  );

  // 待确认阶段：摘要必须同时带 running 与待确认徽标，spinner 与「等待确认」并存。
  assert.equal(ingest(T0 + 2_000), true);
  const waiting = publisher.reserveFlush(subscriptionId);
  assert.ok(waiting);
  const waitingSummary = summaryOf(waiting.frame);
  assert.equal(waitingSummary?.phase, "running");
  // ExitPlanMode 复用 userInput/elicitation 通道承载计划审批（product-projection 的
  // createPendingInteractionFromPermissionEvent），所以计划待确认落在 userInput 计数上。
  assert.equal(waitingSummary?.pendingInteraction?.kind, "userInput");
  assert.equal(waitingSummary?.pendingInteraction?.toolName, "ExitPlanMode");
  assert.equal(waitingSummary?.pendingInteractionSummary?.permissionCount, 0);
  assert.equal(waitingSummary?.pendingInteractionSummary?.userInputCount, 1);
  assert.equal(waiting.commit(), true);

  projection.applyEvent(
    event(
      SessionEventType.PermissionResolved,
      { requestId: REQUEST_ID, toolCallId: TOOL_CALL_ID, decision: "deny", reason: "plan_exit_denied" },
      3_000,
    ),
  );
  // 拒绝已落地但回合尚未收口：pending 必须先消失，不能等 TurnComplete 才清。
  assert.equal(ingest(T0 + 3_000), true);
  const afterDeny = publisher.reserveFlush(subscriptionId);
  assert.ok(afterDeny);
  const denySummary = summaryOf(afterDeny.frame);
  assert.equal(denySummary?.pendingInteraction, undefined);
  assert.equal(denySummary?.pendingInteractionSummary, undefined);
  assert.equal(denySummary?.phase, "running");
  assert.equal(afterDeny.commit(), true);

  projection.applyEvent(
    event(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 1, duration: 4_000, resultType: "cancelled" },
      4_000,
    ),
  );

  // 回合终态：phase 收口且 pending 保持为空——这一帧就是列表行去掉 spinner 的依据。
  assert.equal(ingest(T0 + 4_000), true);
  const terminal = publisher.reserveFlush(subscriptionId);
  assert.ok(terminal);
  const terminalSummary = summaryOf(terminal.frame);
  assert.equal(terminalSummary?.phase, "completedInterrupted");
  assert.equal(terminalSummary?.sessionEnded, true);
  assert.equal(terminalSummary?.pendingInteraction, undefined);
  assert.equal(terminalSummary?.pendingInteractionSummary, undefined);
  assert.equal(terminal.commit(), true);

  // 终态之后不得再有回退帧把列表行打回运行态。
  const afterTerminal = publisher.reserveFlush(subscriptionId);
  assert.equal(afterTerminal, null);
});

test("Plan 拒绝后同一终态重复投影不产生新帧，也不把 pending 写回", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-2");
  const publisher = new SessionsIndexPublisher(WORKSPACE_ID, "index-epoch-2", () => T0);
  const subscribed = publisher.subscribeReserved("connection-2");
  assert.equal(subscribed.reservation?.commit(), true);
  const subscriptionId = subscribed.subscriptionId;

  projection.applyEvent(
    event(SessionEventType.TurnStarted, { turnNumber: 1, input: "写计划", executionKind: "agent" }, 0),
  );
  projection.applyEvent(
    event(
      SessionEventType.PermissionRequested,
      {
        requestId: REQUEST_ID,
        toolCallId: TOOL_CALL_ID,
        toolName: "ExitPlanMode",
        reason: "计划已生成",
        input: { overview: "概述", plan: "# 计划", title: "计划" },
      },
      1_000,
    ),
  );
  assert.equal(
    publisher.ingestConversation(projection.getSnapshot(), { createdAt: T0, lastActivityAt: T0 + 1_000 }),
    true,
  );
  assert.ok(publisher.reserveFlush(subscriptionId)?.commit());

  projection.applyEvent(
    event(
      SessionEventType.PermissionResolved,
      { requestId: REQUEST_ID, toolCallId: TOOL_CALL_ID, decision: "deny", reason: "plan_exit_denied" },
      2_000,
    ),
  );
  projection.applyEvent(
    event(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 1, duration: 3_000, resultType: "cancelled" },
      3_000,
    ),
  );
  const terminalSnapshot = projection.getSnapshot();
  const extra = { createdAt: T0, lastActivityAt: T0 + 3_000 };
  assert.equal(publisher.ingestConversation(terminalSnapshot, extra), true);
  const terminal = publisher.reserveFlush(subscriptionId);
  assert.ok(terminal);
  const summary = summaryOf(terminal.frame);
  assert.equal(summary?.phase, "completedInterrupted");
  assert.equal(summary?.pendingInteraction, undefined);
  assert.equal(summary?.pendingInteractionSummary, undefined);
  assert.equal(terminal.commit(), true);

  // 重放同一终态快照：conflation 必须判等，既不再发帧也不回退 phase。
  assert.equal(publisher.ingestConversation(terminalSnapshot, extra), false);
  assert.equal(publisher.reserveFlush(subscriptionId), null);
});

// ── 失同步标记必须真的到达列表摘要 ──
//
// markDesynced 只改 ConversationSnapshot.control。列表读的是 sessions-index 派生的
// SessionSummary：若派生漏掉 lastErrorCode，或 conflation 判等把它吃掉，
// 列表就会停在没有 lastErrorCode 的旧帧上，把「失同步」和「本轮真失败」混为一谈。

test("失同步标记经 sessions-index 派生后带上 lastErrorCode 并产帧", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch");
  projection.applyEvent(
    event(SessionEventType.TurnStarted, { turnNumber: 1, input: "写计划", executionKind: "agent" }, 0),
  );
  projection.markDesynced({
    code: "fault.projection.desynced",
    message: "conversation projection desynchronized",
    missingRawSeq: 4,
  });
  const snapshot = projection.getSnapshot();
  assert.equal(snapshot.control.phase, "error");
  assert.equal(snapshot.control.lastError?.code, "fault.projection.desynced");

  const index = new SessionsIndexProjection(WORKSPACE_ID, "epoch");
  const deltas = index.upsertFromConversation(snapshot, {
    createdAt: T0,
    lastActivityAt: T0,
  });
  const summary = deltas
    .flatMap((delta) => (delta.op === "session.upserted" ? [delta.session] : []))
    .find((s) => s.sessionId === SESSION_ID);
  assert.ok(summary, "必须产出该会话的 upsert");
  assert.equal(summary.phase, "error");
  assert.equal(summary.lastErrorCode, "fault.projection.desynced");
});

test("lastErrorCode 变化必须产帧（否则列表会停在旧的没有 code 的帧上）", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch");
  projection.applyEvent(
    event(SessionEventType.TurnStarted, { turnNumber: 1, input: "写计划", executionKind: "agent" }, 0),
  );
  projection.applyEvent(
    event(
      SessionEventType.TurnError,
      {
        response: "",
        error: { type: "fault.provider.unavailable", message: "provider 挂了", retryable: true },
      },
      1_000,
    ),
  );
  const index = new SessionsIndexProjection(WORKSPACE_ID, "epoch");
  const extra = { createdAt: T0, lastActivityAt: T0 };
  const first = index.upsertFromConversation(projection.getSnapshot(), extra);
  const failedSummary = first
    .flatMap((delta) => (delta.op === "session.upserted" ? [delta.session] : []))
    .find((s) => s.sessionId === SESSION_ID);
  assert.equal(failedSummary?.lastErrorCode, "fault.provider.unavailable");

  // 同一 phase、只换 lastErrorCode：conflation 不得判等吞掉。
  const sameAgain = index.upsertFromConversation(projection.getSnapshot(), extra);
  assert.deepEqual(sameAgain, [], "完全相同的摘要不产帧（避免无意义刷新）");
});
