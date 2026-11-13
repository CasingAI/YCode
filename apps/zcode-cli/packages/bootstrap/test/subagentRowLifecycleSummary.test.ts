import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 生命周期行的 summaryText 是任务短描述，不是错误诊断；
// 失败/取消不能把 SubagentStopped.error 提升为行标题。

const T0 = 1_700_000_000_000;
const SESSION_ID = "session-subagent-lifecycle-summary";
const TURN_ID = "turn-subagent-lifecycle-summary";

let sequenceNumber = 0;
function event(type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-subagent-lifecycle-summary",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function startTurn(offsetMs = 0): SessionEvent {
  return event(
    SessionEventType.TurnStarted,
    { turnNumber: 1, input: "做点事", executionKind: "agent" },
    offsetMs,
  );
}

function subagentSpawned(agentId: string, description: string, offsetMs: number): SessionEvent {
  return event(
    SessionEventType.SubagentSpawned,
    {
      agentId,
      agentType: "general-purpose",
      childSessionId: `child-${agentId}`,
      parentToolCallId: `call-${agentId}`,
      description,
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
      ...extra,
    },
    offsetMs,
  );
}

function applyAll(projection: ProductProjection, events: SessionEvent[]): void {
  for (const item of events) projection.applyEvent(item);
}

function subagentRowOf(projection: ProductProjection, agentId: string): SubagentRow | undefined {
  return projection
    .getSnapshot()
    .rows.window.find(
      (row): row is SubagentRow => row.kind === "subagent" && row.entityId === agentId,
    );
}

test("失败终态保留任务短描述，error 不覆盖生命周期行标题", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentSpawned("agent-failed", "复核冷恢复描述", 1_000),
    subagentStopped("agent-failed", 2_000, {
      status: "failed",
      error: "Network connection failed for the provider request.",
    }),
  ]);

  const row = subagentRowOf(projection, "agent-failed");
  assert.equal(row?.status, "failed");
  assert.equal(row?.summaryText, "复核冷恢复描述");
});

test("取消终态同样保留任务短描述", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentSpawned("agent-cancelled", "检查设置页空状态", 1_000),
    subagentStopped("agent-cancelled", 2_000, {
      status: "cancelled",
      error: "cancelled by user",
    }),
  ]);

  const row = subagentRowOf(projection, "agent-cancelled");
  assert.equal(row?.status, "cancelled");
  assert.equal(row?.summaryText, "检查设置页空状态");
});

test("终态自带 description 时优先于 error", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentStopped("agent-stop-only", 1_000, {
      status: "failed",
      description: "冷恢复任务描述",
      error: "Network connection failed for the provider request.",
    }),
  ]);

  assert.equal(subagentRowOf(projection, "agent-stop-only")?.summaryText, "冷恢复任务描述");
});

test("结果正文仍优先于已有任务短描述", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentSpawned("agent-result", "初始任务描述", 1_000),
    subagentStopped("agent-result", 2_000, { result: "最终结果正文" }),
  ]);

  assert.equal(subagentRowOf(projection, "agent-result")?.summaryText, "最终结果正文");
});

test("没有任何任务描述时 error 仍作为回退", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    subagentStopped("agent-error-only", 1_000, {
      status: "failed",
      error: "Network connection failed for the provider request.",
    }),
  ]);

  assert.equal(
    subagentRowOf(projection, "agent-error-only")?.summaryText,
    "Network connection failed for the provider request.",
  );
});
