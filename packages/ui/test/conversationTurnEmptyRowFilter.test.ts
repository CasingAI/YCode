import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnitFrame } from "../src/v4/conversationTurnRenderUnits.js";

// 流中占位保序（streaming-pipelined-tool-execution spec）在模型步起点先写一条空 reasoning
// 和一条空 text part 占住 sequence，Stop / 断流等提前退出路径不回填它们。这两条空行必须
// 在共享 render-unit 边界被裁掉，否则时间线出现空白卡片；过滤只能落在共享边界，不能改
// 协议投影——desktop continuous 与 web remote replayable 要共用同一条可见性规则。

function headerRow(turnId: string, rowId: number, state: TurnHeaderRow["state"]): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId,
    turnId,
    origin: "userInput",
    executionKind: "agent",
    state,
    startedAt: 1,
    endedAt: state === "running" ? undefined : 2,
    createdAt: rowId,
    createdAtSeq: rowId,
  };
}

function userRow(turnId: string, rowId: number): UserInputRow {
  return {
    kind: "userInput",
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    text: "写一份计划",
    origin: "realUser",
  };
}

function textRow(turnId: string, rowId: number, text: string): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    text,
    state: "complete",
  };
}

function reasoningRow(turnId: string, rowId: number, text: string): ReasoningRow {
  return {
    kind: "reasoning",
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    text,
    state: "complete",
  };
}

function toolRow(turnId: string, rowId: number): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName: "CreatePlan",
    status: "success",
    inputText: "",
    input: {},
  };
}

function unitOf(rows: ConversationRow[]) {
  const unit = buildConversationTurnRenderUnitFrame(rows, { nowMs: 1000 }).entries[0]?.unit;
  assert.ok(unit, "应产出一个 turn render unit");
  return unit;
}

function workRowIds(unit: { assistantHistoryRows: readonly { rowId: number }[] }) {
  return unit.assistantHistoryRows.map((row) => row.rowId);
}

test("空 text 行被裁掉：Stop 未回填的占位不产生空白卡片", () => {
  // 占位 text(seq 2) → 工具(seq 3) → Stop 补写的真实正文(seq 4)。
  const unit = unitOf([
    headerRow("turn-1", 1, "completedInterrupted"),
    userRow("turn-1", 2),
    textRow("turn-1", 3, ""),
    toolRow("turn-1", 4),
    textRow("turn-1", 5, "计划写好了"),
  ]);

  assert.deepEqual(workRowIds(unit), [4], "只剩工具卡，空正文行不进可见工作行");
  assert.deepEqual(
    unit.assistantTextRows.map((row) => [row.rowId, row.text]),
    [[5, "计划写好了"]],
  );
  assert.equal(unit.latestAssistantTextRow?.rowId, 5, "空占位不得成为 action 锚点");
});

test("有内容的正文行不受影响", () => {
  const unit = unitOf([
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
    textRow("turn-1", 3, "计划写好了"),
  ]);

  assert.equal(unit.assistantTextRows.length, 1);
  assert.equal(unit.latestAssistantTextRow?.text, "计划写好了");
});

test("空 reasoning 与空 text 同款裁剪，有内容的思考行保留", () => {
  const unit = unitOf([
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
    reasoningRow("turn-1", 3, ""),
    reasoningRow("turn-1", 4, "先想清楚步骤"),
    textRow("turn-1", 5, "结语"),
  ]);

  assert.deepEqual(workRowIds(unit), [4], "空 reasoning 占位被裁掉，有内容的思考行保留");
});
