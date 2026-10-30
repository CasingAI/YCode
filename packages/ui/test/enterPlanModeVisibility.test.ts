import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantTextRow,
  ConversationRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnitFrame } from "../src/v4/conversationTurnRenderUnits.js";
import { isPlanCardToolCallRow } from "../src/v4/conversationTurnFlowItems.js";

// EnterPlanMode 是正常工具调用，不是计划审批：成功、运行、失败/拒绝都要作为普通
// 工具行留在时间线。过滤只能留在 UI 派生层，不能改写协议投影；CreatePlan 的计划卡
// 不能替代这条调用记录。

function headerRow(state: TurnHeaderRow["state"]): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId: 1,
    turnId: "turn-1",
    origin: "userInput",
    executionKind: "agent",
    state,
    startedAt: 1,
    endedAt: state === "running" ? undefined : 2,
    createdAt: 1,
    createdAtSeq: 1,
  };
}

function userRow(): UserInputRow {
  return {
    kind: "userInput",
    rowId: 2,
    turnId: "turn-1",
    createdAt: 2,
    createdAtSeq: 2,
    text: "先出方案再动手",
    origin: "realUser",
  };
}

function textRow(rowId: number, text: string): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    text,
    state: "complete",
  };
}

function enterPlanModeRow(rowId: number, status: ToolCallRow["status"]): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName: "EnterPlanMode",
    status,
    inputText: "{}",
    input: {},
    ...(status === "error"
      ? { error: { code: "permission_denied", message: "Automation execution is locked" } }
      : {}),
    ...(status === "cancelled"
      ? {
          permissionDenial: {
            decision: "deny" as const,
            reason: "Blocked while automation is running",
          },
        }
      : {}),
  };
}

function createPlanRow(rowId: number): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId: "turn-1",
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName: "CreatePlan",
    status: "success",
    inputText: '{"title":"方案","overview":"概述","plan":"# 计划"}',
    input: { title: "方案", overview: "概述", plan: "# 计划" },
  };
}

function unitOf(rows: ConversationRow[]) {
  const frame = buildConversationTurnRenderUnitFrame(rows, { nowMs: 1000 });
  const unit = frame.entries[0]?.unit;
  assert.ok(unit, "应产出一个 turn render unit");
  return unit;
}

test("完成态：成功、失败、拒绝的 EnterPlanMode 都作为普通工作行可见", () => {
  const unit = unitOf([
    headerRow("completedSuccess"),
    userRow(),
    enterPlanModeRow(3, "success"),
    enterPlanModeRow(4, "error"),
    enterPlanModeRow(5, "cancelled"),
    textRow(6, "已进入计划模式"),
  ]);

  assert.deepEqual(
    unit.assistantWorkRows
      .filter((row): row is ToolCallRow => row.kind === "toolCall")
      .map((row) => [row.rowId, row.status]),
    [
      [3, "success"],
      [4, "error"],
      [5, "cancelled"],
    ],
    "三种终态都留在可见工作行里，成功/失败/拒绝不得被吞掉",
  );
  assert.deepEqual(
    unit.assistantHistoryRows.map((row) => row.rowId),
    [3, 4, 5],
    "折叠区也必须保留调用记录",
  );

  const flowRowIds = unit.flowItems.flatMap((item) =>
    item.kind === "assistantHistory" || item.kind === "assistantWork"
      ? item.rows.map((row) => row.rowId)
      : [],
  );
  assert.deepEqual(flowRowIds, [3, 4, 5], "时间线 flow 里三条调用记录都在");
});

test("运行中：EnterPlanMode 的 running 行本身构成可见轮", () => {
  const unit = unitOf([headerRow("running"), userRow(), enterPlanModeRow(3, "running")]);

  assert.equal(unit.isRunning, true);
  assert.deepEqual(
    unit.assistantWorkRows.map((row) => [row.rowId, (row as ToolCallRow).status]),
    [[3, "running"]],
    "运行中的切档调用不能被当成空轮或隐藏",
  );
  const flowRow = unit.flowItems.find(
    (item) => item.kind === "assistantWork" || item.kind === "assistantHistory",
  );
  assert.ok(flowRow && (flowRow.kind === "assistantWork" || flowRow.kind === "assistantHistory"));
  assert.deepEqual(
    flowRow.rows.map((row) => row.rowId),
    [3],
  );
});

test("CreatePlan 仍是唯一的计划卡，EnterPlanMode 调用记录不被替代", () => {
  const enterRow = enterPlanModeRow(3, "success");
  const planRow = createPlanRow(4);
  const unit = unitOf([
    headerRow("completedSuccess"),
    userRow(),
    enterRow,
    planRow,
    textRow(5, "计划已提交"),
  ]);

  assert.deepEqual(
    unit.assistantWorkRows
      .filter((row): row is ToolCallRow => row.kind === "toolCall")
      .map((row) => row.rowId),
    [3, 4],
    "EnterPlanMode 与 CreatePlan 是两条各自独立的工具行",
  );
  assert.equal(isPlanCardToolCallRow(enterRow), false, "EnterPlanMode 不得被当成计划卡");
  assert.equal(isPlanCardToolCallRow(planRow), true, "CreatePlan 仍独占计划卡判定");
});
