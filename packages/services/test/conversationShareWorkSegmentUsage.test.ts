import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationRow,
  SubagentRow,
  ToolCallRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationSharePublicProjection } from "../src/conversation-share/conversationSharePublicProjection.js";

// 分享页复用同一套聚合数字，但不得带出子代理会话身份与内部明细：
// SubagentRow 继续被 allow-list 过滤，工作段只留 usage 两个数。

const T0 = 1_700_000_000_000;

function turnHeaderRow(): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId: 1,
    turnId: "turn-1",
    entityId: "turn-1",
    productTurnId: "product-turn-1",
    visibility: "visible",
    createdAt: T0,
    createdAtSeq: 1,
    origin: "userInput",
    executionKind: "agent",
    state: "completed",
    startedAt: T0,
    endedAt: T0 + 60_000,
    workSegments: [
      {
        segmentId: "turn-1:initial",
        startedAt: T0,
        endedAt: T0 + 60_000,
        activeMs: 60_000,
        usage: { toolCallCount: 6, reasoningDurationMs: 30_000 },
      },
    ],
  } as TurnHeaderRow;
}

function userInputRow(): ConversationRow {
  return {
    kind: "userInput",
    rowId: 2,
    turnId: "turn-1",
    entityId: "user-1",
    productTurnId: "product-turn-1",
    visibility: "visible",
    createdAt: T0,
    createdAtSeq: 2,
    text: "做点事",
    origin: "realUser",
  } as ConversationRow;
}

function toolCallRow(): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: 3,
    turnId: "turn-1",
    entityId: "call-1",
    productTurnId: "product-turn-1",
    visibility: "visible",
    createdAt: T0 + 1_000,
    createdAtSeq: 3,
    toolCallId: "call-1",
    toolName: "Agent",
    status: "success",
    inputText: "",
    input: {},
  } as ToolCallRow;
}

function subagentRow(): SubagentRow {
  return {
    kind: "subagent",
    rowId: 4,
    turnId: "turn-1",
    entityId: "agent-1",
    productTurnId: "product-turn-1",
    visibility: "visible",
    createdAt: T0 + 2_000,
    createdAtSeq: 4,
    parentToolCallId: "call-1",
    subagentType: "general-purpose",
    status: "success",
    summaryText: "子任务完成",
    endedAt: T0 + 30_000,
    usage: { toolCallCount: 3, reasoningDurationMs: 20_000 },
  } as SubagentRow;
}

test("分享投影保留工作段 usage 聚合数字", () => {
  const projection = buildConversationSharePublicProjection({
    rows: [turnHeaderRow(), userInputRow(), toolCallRow()],
    selectedProductTurnIds: ["product-turn-1"],
  });

  const header = projection.rows.find((row) => row.kind === "turnHeader");
  assert.equal(header?.kind, "turnHeader");
  assert.deepEqual(header?.workSegments?.[0]?.usage, {
    toolCallCount: 6,
    reasoningDurationMs: 30_000,
  });
});

test("分享投影不输出子代理行，也不泄漏 childSessionId 与子代理用量", () => {
  const projection = buildConversationSharePublicProjection({
    rows: [turnHeaderRow(), userInputRow(), toolCallRow(), subagentRow()],
    selectedProductTurnIds: ["product-turn-1"],
  });

  assert.equal(
    projection.rows.some((row) => row.kind === "subagent"),
    false,
  );
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("childSessionId"), false);
  assert.equal(serialized.includes("agent-1"), false);
  // 聚合数字仍然可见；子代理内部明细不额外出现。
  assert.equal(serialized.includes("toolCallCount"), true);
});

test("没有 usage 的旧工作段原样分享，不补 0", () => {
  const header = turnHeaderRow();
  const withoutUsage = {
    ...header,
    workSegments: [
      { segmentId: "turn-1:initial", startedAt: T0, endedAt: T0 + 1_000, activeMs: 1_000 },
    ],
  } as TurnHeaderRow;

  const projection = buildConversationSharePublicProjection({
    rows: [withoutUsage, userInputRow()],
    selectedProductTurnIds: ["product-turn-1"],
  });

  const shared = projection.rows.find((row) => row.kind === "turnHeader");
  assert.equal(shared?.kind, "turnHeader");
  assert.equal(shared?.workSegments?.[0]?.usage, undefined);
});
