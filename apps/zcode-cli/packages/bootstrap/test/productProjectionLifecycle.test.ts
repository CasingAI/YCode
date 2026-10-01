import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

const T0 = 1_700_000_000_000;
const SESSION_ID = "session-plan-lifecycle";
const TURN_ID = "turn-plan-lifecycle";
const TOOL_CALL_ID = "call-exit-plan";
const REQUEST_ID = "request-plan-approval";

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-plan-lifecycle",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function toolRow(projection: ProductProjection): ToolCallRow | undefined {
  return projection
    .getSnapshot()
    .rows.window.find((row): row is ToolCallRow => row.kind === "toolCall");
}

test("Plan 请求、拒绝与回合终态按序清空 pending 并收口工具行", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  projection.applyEvent(
    event(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "制定计划", executionKind: "agent" },
      0,
    ),
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

  assert.equal(projection.getSnapshot().control.phase, "running");
  assert.equal(projection.getSnapshot().pendingInteractions.length, 1);
  assert.equal(toolRow(projection)?.status, "pendingApproval");

  projection.applyEvent(
    event(
      SessionEventType.PermissionResolved,
      {
        requestId: REQUEST_ID,
        toolCallId: TOOL_CALL_ID,
        decision: "deny",
        reason: "plan_exit_denied",
      },
      3_000,
    ),
  );
  assert.equal(projection.getSnapshot().pendingInteractions.length, 0);
  assert.equal(toolRow(projection)?.status, "cancelled");

  projection.applyEvent(
    event(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 1,
        duration: 4_000,
        resultType: "cancelled",
      },
      4_000,
    ),
  );
  assert.equal(projection.getSnapshot().control.phase, "completedInterrupted");
  assert.equal(projection.getSnapshot().control.sessionEnded, true);
  assert.equal(projection.getSnapshot().pendingInteractions.length, 0);
  assert.equal(toolRow(projection)?.status, "cancelled");
});

test("会话在线帧发送失败后回滚为 snapshot，避免空 delta 跳过终态", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, "publisher-epoch", { now: () => T0 });
  const subscribed = publisher.subscribeReserved({
    connectionId: "connection-1",
    deliveryProfile: "replayable",
  });
  assert.equal(subscribed.reservation?.commit(), true);

  publisher.ingest(
    event(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "执行计划", executionKind: "agent" },
      1_000,
    ),
  );
  const failed = publisher.reserveFlush(subscribed.ack.subscriptionId);
  assert.ok(failed);
  assert.equal(failed.frame.payload.kind, "deltas");
  assert.equal(failed.rollback(), true);

  const recovery = publisher.reserveFlush(subscribed.ack.subscriptionId);
  assert.ok(recovery);
  assert.notEqual(recovery, failed);
  assert.equal(recovery.frame.payload.kind, "snapshot");
  assert.equal(recovery.frame.fromSeq, 0);
  assert.equal(recovery.frame.toSeq, failed.frame.toSeq);
  assert.equal(recovery.commit(), true);
});
