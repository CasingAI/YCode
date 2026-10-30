import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationSharePublicProjection } from "../src/conversation-share/conversationSharePublicProjection.js";
import { sanitizeUnsupportedShareStructures } from "../src/conversation-share/conversationShareService.js";

// 公开分享页与聊天时间线同规：EnterPlanMode 是普通工具调用记录，成功/失败/拒绝
// 都要进入公开载荷，不能被 sanitize 当成内部结构静默移除。

const T0 = 1_700_000_000_000;

function headerRow(): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId: 1,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: T0,
    createdAtSeq: 1,
    origin: "userInput",
    executionKind: "agent",
    state: "completed",
    startedAt: T0,
    endedAt: T0 + 1_000,
  } as TurnHeaderRow;
}

function userInputRow(): UserInputRow {
  return {
    kind: "userInput",
    rowId: 2,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: T0 + 1,
    createdAtSeq: 2,
    text: "先出方案",
    origin: "realUser",
  } as UserInputRow;
}

function enterPlanModeRow(rowId: number, status: ToolCallRow["status"]): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: T0 + rowId,
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
  } as ToolCallRow;
}

test("公开分享保留 EnterPlanMode 的成功、失败与拒绝调用记录", () => {
  const rows: ConversationRow[] = [
    headerRow(),
    userInputRow(),
    enterPlanModeRow(3, "success"),
    enterPlanModeRow(4, "error"),
    enterPlanModeRow(5, "cancelled"),
  ];

  const sanitized = sanitizeUnsupportedShareStructures(rows);
  assert.deepEqual(
    sanitized.map((row) => row.rowId),
    [1, 2, 3, 4, 5],
    "sanitize 不得移除 EnterPlanMode 行",
  );

  const projection = buildConversationSharePublicProjection({
    rows: sanitized,
    selectedProductTurnIds: ["product-turn-1"],
  });
  const sharedToolRows = projection.rows.filter(
    (row): row is ToolCallRow => row.kind === "toolCall",
  );
  assert.deepEqual(
    sharedToolRows.map((row) => [row.toolName, row.status]),
    [
      ["EnterPlanMode", "success"],
      ["EnterPlanMode", "error"],
      ["EnterPlanMode", "cancelled"],
    ],
    "公开投影里三条调用记录及其状态都保留",
  );
});
