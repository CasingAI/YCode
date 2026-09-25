import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { SubagentRow, TurnHeaderRow, WorkSegmentUsage } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 工作段 usage 的唯一 owner 是 CLI ProductProjection：
// 父直接工具 + 父 Agent launcher（ToolCallRow 计一次）+ child session 及后代合计。
// UI 只读这个字段，不订阅 child session、不重复累计。

const T0 = 1_700_000_000_000;
const SESSION_ID = "session-work-segment-usage";
const TURN_ID = "turn-work-segment-usage";

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-work-segment-usage",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function applyAll(projection: ProductProjection, events: SessionEvent[]): void {
  for (const item of events) projection.applyEvent(item);
}

function startTurn(offsetMs = 0): SessionEvent {
  return event(
    SessionEventType.TurnStarted,
    { turnNumber: 1, input: "做点事", executionKind: "agent" },
    offsetMs,
  );
}

function toolScheduled(callId: string, toolName: string, offsetMs: number): SessionEvent {
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
  );
}

function toolCompleted(callId: string, offsetMs: number): SessionEvent {
  return event(
    SessionEventType.ToolCallResult,
    {
      toolCallId: callId,
      result: { success: true, content: "ok" },
      duration: 1_000,
    },
    offsetMs,
  );
}

function reasoningSpan(partId: string, startOffsetMs: number, endOffsetMs: number): SessionEvent[] {
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
    ),
    event(
      SessionEventType.ModelStreaming,
      { kind: "reasoning_end", delta: "", done: false, partId },
      endOffsetMs,
    ),
  ];
}

function subagentSpawned(agentId: string, offsetMs: number): SessionEvent {
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
  );
}

function subagentStopped(
  agentId: string,
  offsetMs: number,
  extra: Record<string, unknown> = {},
): SessionEvent {
  return event(
    SessionEventType.SubagentStopped,
    {
      agentId,
      agentType: "general-purpose",
      childSessionId: `child-${agentId}`,
      parentToolCallId: `call-${agentId}`,
      status: "completed",
      background: false,
      totalDurationMs: offsetMs,
      ...extra,
    },
    offsetMs,
  );
}

function headerOf(projection: ProductProjection): TurnHeaderRow | undefined {
  return projection
    .getSnapshot()
    .rows.window.find((row): row is TurnHeaderRow => row.kind === "turnHeader");
}

function usageOf(projection: ProductProjection): WorkSegmentUsage | undefined {
  return headerOf(projection)?.workSegments?.[0]?.usage;
}

function subagentRowOf(projection: ProductProjection, agentId: string): SubagentRow | undefined {
  return projection
    .getSnapshot()
    .rows.window.find(
      (row): row is SubagentRow => row.kind === "subagent" && row.entityId === agentId,
    );
}

test("所有工具类别统一计数：终端、MCP、编辑都只算一次，不按类别拆分", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    toolScheduled("call-bash", "Bash", 1_000),
    toolCompleted("call-bash", 2_000),
    toolScheduled("call-mcp", "mcp__linear__list", 3_000),
    toolCompleted("call-mcp", 4_000),
    toolScheduled("call-edit", "Edit", 5_000),
    toolCompleted("call-edit", 6_000),
    toolScheduled("call-read", "Read", 7_000),
    toolCompleted("call-read", 8_000),
  ]);

  assert.equal(usageOf(projection)?.toolCallCount, 4);
});

test("失败与权限拒绝的工具调用同样计数", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    toolScheduled("call-ok", "Bash", 1_000),
    toolCompleted("call-ok", 2_000),
    toolScheduled("call-denied", "ExitPlanMode", 3_000),
    event(
      SessionEventType.PermissionRequested,
      {
        requestId: "request-1",
        toolCallId: "call-denied",
        toolName: "ExitPlanMode",
        reason: "需要审批",
        input: {},
      },
      4_000,
    ),
    event(
      SessionEventType.PermissionResolved,
      { requestId: "request-1", toolCallId: "call-denied", decision: "deny" },
      5_000,
    ),
    toolScheduled("call-failed", "WebFetch", 6_000),
    event(
      SessionEventType.ToolCallError,
      { toolCallId: "call-failed", toolName: "WebFetch", error: "网络失败" },
      7_000,
    ),
  ]);

  assert.equal(usageOf(projection)?.toolCallCount, 3);
});

test("思考耗时按 reasoning 区间累加，父段 12 秒显示为 12000ms", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [startTurn(), ...reasoningSpan("part-1", 1_000, 13_000)]);

  assert.equal(usageOf(projection)?.reasoningDurationMs, 12_000);
});

test("父段直接 2 次工具 + Agent launcher 1 次 + child 内部 3 次，合计 6 次", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    toolScheduled("call-a", "Bash", 1_000),
    toolCompleted("call-a", 2_000),
    toolScheduled("call-b", "Read", 3_000),
    toolCompleted("call-b", 4_000),
    // 父侧 Agent 委派本身就是一次工具调用
    toolScheduled("call-agent", "Agent", 5_000),
    toolCompleted("call-agent", 6_000),
    subagentSpawned("agent-1", 7_000),
    subagentStopped("agent-1", 8_000, {
      totalToolUseCount: 3,
      totalReasoningDurationMs: 20_000,
    }),
  ]);

  assert.equal(usageOf(projection)?.toolCallCount, 6);
});

test("父 reasoning 10 秒 + child reasoning 20 秒，合计 30 秒", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    ...reasoningSpan("parent-part", 1_000, 11_000),
    subagentSpawned("agent-1", 12_000),
    subagentStopped("agent-1", 13_000, {
      totalToolUseCount: 3,
      totalReasoningDurationMs: 20_000,
    }),
  ]);

  assert.equal(usageOf(projection)?.reasoningDurationMs, 30_000);
});

test("SubagentRow.usage 承载 child session 及其后代合计，不含父侧 launcher", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentSpawned("agent-1", 1_000),
    subagentStopped("agent-1", 2_000, {
      totalToolUseCount: 3,
      totalReasoningDurationMs: 20_000,
    }),
  ]);

  const row = subagentRowOf(projection, "agent-1");
  assert.deepEqual(row?.usage, { toolCallCount: 3, reasoningDurationMs: 20_000 });
  // 父段只有委派本身这一次工具调用
  assert.equal(usageOf(projection)?.toolCallCount, 3);
});

test("grandchild 用量已包含在 child 合计里，父段不会二次累加", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentSpawned("agent-1", 1_000),
    // child 自己的统计已把 grandchild 递归合并进来
    subagentStopped("agent-1", 2_000, {
      totalToolUseCount: 5,
      totalReasoningDurationMs: 12_000,
    }),
  ]);

  assert.equal(usageOf(projection)?.toolCallCount, 5);
  assert.equal(usageOf(projection)?.reasoningDurationMs, 12_000);
});

test("重复投递同一个 SubagentStopped 不重复计数，也不使数字回退", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentSpawned("agent-1", 1_000),
    subagentStopped("agent-1", 2_000, {
      totalToolUseCount: 3,
      totalReasoningDurationMs: 20_000,
    }),
  ]);
  const afterFirst = usageOf(projection);

  applyAll(projection, [
    subagentStopped("agent-1", 3_000, {
      totalToolUseCount: 3,
      totalReasoningDurationMs: 20_000,
    }),
  ]);

  assert.deepEqual(usageOf(projection), afterFirst);
  assert.equal(usageOf(projection)?.toolCallCount, 3);
});

test("旧 SubagentStopped 不带用量字段时不伪造 0，也不改变已有统计", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentSpawned("agent-1", 1_000),
    subagentStopped("agent-1", 2_000, {
      totalToolUseCount: 3,
      totalReasoningDurationMs: 20_000,
    }),
  ]);

  applyAll(projection, [subagentStopped("agent-1", 3_000, { status: "cancelled" })]);

  assert.equal(usageOf(projection)?.toolCallCount, 3);
  assert.equal(usageOf(projection)?.reasoningDurationMs, 20_000);
});

test("子代理失败/取消时回读到的已发生用量仍进入父工作段", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentSpawned("agent-1", 1_000),
    subagentStopped("agent-1", 2_000, {
      status: "failed",
      totalToolUseCount: 2,
      totalReasoningDurationMs: 4_000,
      error: "child runtime failed",
    }),
  ]);

  assert.equal(usageOf(projection)?.toolCallCount, 2);
  assert.equal(usageOf(projection)?.reasoningDurationMs, 4_000);
});

function guideSteerDrained(offsetMs: number, messageId: string): SessionEvent {
  return event(
    SessionEventType.TurnSteerDrained,
    {
      pendingInputIds: [`pending-${messageId}`],
      targetTurnId: TURN_ID,
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
  );
}

test("用量只统计当前工作段：guide 段重新起算，旧段数字保留不回退", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    toolScheduled("call-1", "Bash", 1_000),
    toolCompleted("call-1", 2_000),
  ]);
  assert.equal(usageOf(projection)?.toolCallCount, 1);

  // guide steer 在同一 product turn 内开新工作段。
  applyAll(projection, [guideSteerDrained(10_000, "message-guide-1")]);
  const segments = headerOf(projection)?.workSegments ?? [];
  assert.equal(segments.length, 2);
  // 旧段冻结在自己的数字上。
  assert.equal(segments[0]?.usage?.toolCallCount, 1);
  // 新段尚未产生任何工具。
  assert.equal(segments[1]?.usage?.toolCallCount, 0);

  applyAll(projection, [toolScheduled("call-2", "Read", 11_000), toolCompleted("call-2", 12_000)]);

  const afterGuide = headerOf(projection)?.workSegments ?? [];
  assert.equal(afterGuide[0]?.usage?.toolCallCount, 1);
  assert.equal(afterGuide[1]?.usage?.toolCallCount, 1);
});

test("turn 收口与 usage 在同一 revision 内合并成一条 header upsert", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    toolScheduled("call-1", "Bash", 1_000),
    toolCompleted("call-1", 2_000),
  ]);

  const deltas = projection.applyEvent(
    event(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 0, toolCallCount: 1, duration: 3_000, resultType: "success" },
      5_000,
    ),
  );

  const headerUpserts = deltas.filter(
    (delta) => delta.op === "row.upserted" && delta.row.kind === "turnHeader",
  );
  // 同一 rowId 至多一条 upsert；收口写入的 endedAt/activeMs 与 usage 必须在同一条里。
  assert.equal(headerUpserts.length, 1);
  const header = headerUpserts[0]?.op === "row.upserted" ? headerUpserts[0].row : undefined;
  assert.equal(header?.kind, "turnHeader");
  assert.match(header?.state ?? "", /^completed/u);
  assert.deepEqual(header?.workSegments?.[0]?.usage, { toolCallCount: 1, reasoningDurationMs: 0 });
  // 收口写入的段时长与 usage 落在同一条里，没有被后到的 usage upsert 覆盖掉。
  assert.equal(header?.workSegments?.[0]?.endedAt, T0 + 5_000);
});

test("纯文本增量不触发 usage 重算，也不产生 header upsert", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [startTurn()]);

  const deltas = projection.applyEvent(
    event(
      SessionEventType.ModelStreaming,
      { kind: "text", delta: "hello", done: false, assistantMessageId: "m1" },
      1_000,
    ),
  );

  assert.equal(
    deltas.some((delta) => delta.op === "row.upserted" && delta.row.kind === "turnHeader"),
    false,
  );
});
