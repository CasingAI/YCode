import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { TurnHeaderRow, WorkSegmentUsage } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// spec（conversation-work-segment-usage.md）冷恢复收口不变量的等价性守卫：
// 同一事件序列，直播逐事件收敛（applyEvent）与冷恢复批量收口
// （beginHydrationReplay → applyHydrationEvent×N → completeHydrationReplay）
// 结束后，所有 turnHeader 的 workSegments[].usage 必须逐字段一致。
// 只断言 usage（toolCallCount / reasoningDurationMs），不断言修订号、
// delta 条数或中间态——那两条路径本就允许在不发布的中间态上不同。

const T0 = 1_700_000_000_000;
const SESSION_ID = "session-usage-hydration-equivalence";

let sequenceNumber = 0;
function event(
  type: SessionEventType,
  payload: unknown,
  offsetMs: number,
  turnId: string,
): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-usage-equivalence",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

const TURN_1 = "turn-usage-equivalence-1";
const TURN_2 = "turn-usage-equivalence-2";

function startTurn(turnId: string, messageId: string, turnNumber: number, offsetMs: number) {
  // messageId 是 rewind 反查 row 的锚点（normalizer 读 payload.messageId）。
  return event(
    SessionEventType.TurnStarted,
    { turnNumber, input: `第 ${turnNumber} 轮`, executionKind: "agent", messageId },
    offsetMs,
    turnId,
  );
}

function toolScheduled(callId: string, toolName: string, offsetMs: number, turnId: string) {
  return event(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId: callId,
      assistantMessageId: `assistant-${callId}`,
      toolName,
      input: {},
      schedule: { parallelGroups: [[callId]], executionOrder: [callId] },
    },
    offsetMs,
    turnId,
  );
}

function toolCompleted(callId: string, offsetMs: number, turnId: string) {
  return event(
    SessionEventType.ToolCallResult,
    { toolCallId: callId, result: { success: true, content: "ok" }, duration: 1_000 },
    offsetMs,
    turnId,
  );
}

function reasoningSpan(partId: string, startOffsetMs: number, endOffsetMs: number, turnId: string) {
  return [
    event(
      SessionEventType.ModelStreaming,
      {
        kind: "reasoning_start",
        delta: "",
        done: false,
        assistantMessageId: `assistant-${partId}`,
        partId,
      },
      startOffsetMs,
      turnId,
    ),
    event(
      SessionEventType.ModelStreaming,
      { kind: "reasoning_end", delta: "", done: false, partId },
      endOffsetMs,
      turnId,
    ),
  ];
}

function subagentSpawned(agentId: string, offsetMs: number, turnId: string) {
  return event(
    SessionEventType.SubagentSpawned,
    {
      agentId,
      agentType: "general-purpose",
      childSessionId: `child-${agentId}`,
      parentToolCallId: `call-${agentId}`,
      description: "子任务",
      prompt: "去做",
      status: "running",
      background: false,
    },
    offsetMs,
    turnId,
  );
}

function subagentStopped(agentId: string, offsetMs: number, turnId: string) {
  return event(
    SessionEventType.SubagentStopped,
    {
      agentId,
      agentType: "general-purpose",
      childSessionId: `child-${agentId}`,
      parentToolCallId: `call-${agentId}`,
      status: "completed",
      background: false,
      totalDurationMs: 1_000,
      totalToolUseCount: 3,
      totalReasoningDurationMs: 20_000,
    },
    offsetMs,
    turnId,
  );
}

function guideSteerDrained(offsetMs: number, messageId: string, turnId: string) {
  // guide steer 在同一 product turn 内开新工作段（多段覆盖）。
  return event(
    SessionEventType.TurnSteerDrained,
    {
      pendingInputIds: [`pending-${messageId}`],
      targetTurnId: turnId,
      injectedMessageIds: [messageId],
      drainedInputs: [
        {
          pendingInputId: `pending-${messageId}`,
          messageId,
          text: "换个方向",
          delivery: "guide",
        },
      ],
    },
    offsetMs,
    turnId,
  );
}

function turnComplete(offsetMs: number, turnId: string) {
  return event(
    SessionEventType.TurnComplete,
    { response: "done", tokenCount: 0, toolCallCount: 3, duration: 20_000, resultType: "success" },
    offsetMs,
    turnId,
  );
}

function rewindTurn(targetMessageId: string, offsetMs: number) {
  return event(
    SessionEventType.RewindTriggered,
    {
      targetMessageId,
      scope: "conversation",
      branchCutAfterMessageId: targetMessageId,
      branchGeneration: 1,
    },
    offsetMs,
    targetMessageId === "m-user-2" ? TURN_2 : TURN_1,
  );
}

/**
 * 目标场景（覆盖评审要求的三类形态）：
 * 1. 多工作段：turn-1 内 guide steer 切出第二段，两段各自计数；
 * 2. 子代理合计并入父段：launcher 工具 1 次 + child 合并 {3, 20000}；
 * 3. rewind 删行：turn-2 整段被删，其工具/思考不得计入任何剩余段。
 */
function scenarioEvents(): SessionEvent[] {
  return [
    startTurn(TURN_1, "m-user-1", 1, 0),
    toolScheduled("call-1", "Bash", 1_000, TURN_1),
    toolCompleted("call-1", 2_000, TURN_1),
    ...reasoningSpan("part-1", 3_000, 9_000, TURN_1),
    toolScheduled("call-agent-1", "Agent", 10_000, TURN_1),
    toolCompleted("call-agent-1", 11_000, TURN_1),
    subagentSpawned("agent-1", 12_000, TURN_1),
    subagentStopped("agent-1", 13_000, TURN_1),
    guideSteerDrained(14_000, "m-guide-1", TURN_1),
    toolScheduled("call-2", "Read", 15_000, TURN_1),
    toolCompleted("call-2", 16_000, TURN_1),
    ...reasoningSpan("part-2", 17_000, 19_000, TURN_1),
    turnComplete(20_000, TURN_1),
    startTurn(TURN_2, "m-user-2", 2, 21_000),
    toolScheduled("call-3", "Edit", 22_000, TURN_2),
    toolCompleted("call-3", 23_000, TURN_2),
    ...reasoningSpan("part-3", 24_000, 27_000, TURN_2),
    rewindTurn("m-user-2", 28_000),
  ];
}

function replayLive(events: SessionEvent[]): ProductProjection {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  for (const item of events) projection.applyEvent(item);
  return projection;
}

function replayBatch(events: SessionEvent[]): ProductProjection {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  projection.beginHydrationReplay();
  for (const item of events) projection.applyHydrationEvent(item);
  // 收口时间 = 最后一条事件时间（与 publisher tryBatchHydration 的传参一致）。
  projection.completeHydrationReplay(
    events[events.length - 1]?.timestamp.getTime() ?? T0,
  );
  return projection;
}

interface HeaderUsageSnapshot {
  entityId: string;
  state: string;
  segmentUsages: (WorkSegmentUsage | undefined)[];
}

function headerUsages(projection: ProductProjection): Map<string, HeaderUsageSnapshot> {
  const headers = new Map<string, HeaderUsageSnapshot>();
  for (const row of projection.getSnapshot().rows.window) {
    if (row.kind !== "turnHeader") continue;
    const header = row as TurnHeaderRow;
    headers.set(header.entityId, {
      entityId: header.entityId,
      state: header.state,
      segmentUsages: (header.workSegments ?? []).map((segment) => segment.usage),
    });
  }
  return headers;
}

test("冷恢复批量收口与直播逐事件收敛的 turnHeader usage 逐字段一致", () => {
  const events = scenarioEvents();
  const live = replayLive(events);
  const batch = replayBatch(events);

  const liveHeaders = headerUsages(live);
  const batchHeaders = headerUsages(batch);
  assert.equal(
    liveHeaders.size,
    batchHeaders.size,
    "两条路径收敛后的 turnHeader 集合必须一致",
  );
  for (const [entityId, liveHeader] of liveHeaders) {
    const batchHeader = batchHeaders.get(entityId);
    assert.ok(batchHeader, `批量路径缺少 turnHeader ${entityId}`);
    assert.deepEqual(
      batchHeader.segmentUsages,
      liveHeader.segmentUsages,
      `turnHeader ${entityId} 的工作段 usage 与直播不一致`,
    );
  }
});

test("批量收口后 turn-1 两段的 usage 数值正确（5/26000 与 1/2000）", () => {
  const batch = replayBatch(scenarioEvents());
  const header = [...headerUsages(batch).values()].find((_, index) => index === 0);
  assert.ok(header, "缺少 turn-1 turnHeader");
  assert.equal(header.segmentUsages.length, 2);
  // 首段：直接工具 call-1（1）+ launcher call-agent-1（1）+ child 合并 3 次 = 5；
  // 思考 = part-1 闭合 6000ms + child 的 20000ms = 26000ms。
  assert.deepEqual(header.segmentUsages[0], { toolCallCount: 5, reasoningDurationMs: 26_000 });
  // guide 段：call-2 一次工具；part-2 闭合 2000ms。
  assert.deepEqual(header.segmentUsages[1], { toolCallCount: 1, reasoningDurationMs: 2_000 });
});

test("rewind 删行后，被删 turn 的工具与思考不计入任何剩余段", () => {
  const batch = replayBatch(scenarioEvents());
  const headers = [...headerUsages(batch).values()];
  // turn-2 整段被 rewind 移除，只剩 turn-1 的 header。
  assert.equal(headers.length, 1);
  const totalToolCalls = headers.reduce(
    (sum, header) =>
      sum + header.segmentUsages.reduce((segmentSum, usage) => segmentSum + (usage?.toolCallCount ?? 0), 0),
    0,
  );
  const totalReasoningMs = headers.reduce(
    (sum, header) =>
      sum +
      header.segmentUsages.reduce(
        (segmentSum, usage) => segmentSum + (usage?.reasoningDurationMs ?? 0),
        0,
      ),
    0,
  );
  // call-3（turn-2）与 part-3 不得出现。
  assert.equal(totalToolCalls, 6);
  assert.equal(totalReasoningMs, 28_000);
});

test("批量收口对没有工作段的投影是无操作", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  projection.beginHydrationReplay();
  projection.completeHydrationReplay(T0);
  assert.equal(projection.getSnapshot().rows.window.length, 0);
});
