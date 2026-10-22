import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnitFrame } from "../src/v4/conversationTurnRenderUnits.js";

// 轮内运行态的权威来源与归属（docs/specs/conversation-turn-running-authority.md）。
//
// 背景：尾窗按整轮取，但一轮自身超过单帧体积预算（960KB）时会被按行切开，客户端
// 窗口里就只剩该轮的尾段、没有轮头。轮头缺失时旧的判定退化成「窗口里此刻有没有
// 行在跑」，而模型请求空档里一个满足条件的行都没有 → 判成已结束 → 末段过程行收起；
// 下一条工具或思考开始 → 又展开。展开与折叠差几十行，贴底视口整屏换内容，用户看到
// 的是同一个任务在两种形态之间反复跳。
//
// 修复口径：会话控制面（control.phase）才是权威，归属要求「窗口末轮 × 窗口连尾」。

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
    text: "提问",
    origin: "realUser",
  };
}

function toolRow(turnId: string, rowId: number, status: ToolCallRow["status"]): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName: "Read",
    status,
    inputText: "",
    input: {},
  };
}

function isRunningOf(
  rows: ConversationRow[],
  options: Parameters<typeof buildConversationTurnRenderUnitFrame>[1],
): boolean[] {
  const frame = buildConversationTurnRenderUnitFrame(rows, options);
  return frame.entries.map((entry) => entry.unit.isRunning);
}

test("轮头被裁掉：会话在跑且窗口连尾时，末轮判为运行中（不依赖行状态）", () => {
  // 模型请求空档：工具已结束、下一条工具或思考还没开始——窗口里没有任何在跑的行。
  const rows: ConversationRow[] = [userRow("turn-1", 2), toolRow("turn-1", 3, "success")];

  assert.deepEqual(
    isRunningOf(rows, { sessionPhase: "running", windowConnectedToTail: true }),
    [true],
    "会话在跑时缺轮头的末轮必须判为运行中，否则过程行会在模型空档里塌陷",
  );
});

test("轮头被裁掉：窗口脱尾时，历史末轮不被会话运行态顶成运行中", () => {
  // 轮导航跳到中部：窗口末端不是会话尾部，末轮是早已完成的历史轮。
  const rows: ConversationRow[] = [userRow("turn-1", 2), toolRow("turn-1", 3, "success")];

  assert.deepEqual(isRunningOf(rows, { sessionPhase: "running", windowConnectedToTail: false }), [
    false,
  ]);
});

test("轮头被裁掉：会话终态时末轮不判运行中", () => {
  const rows: ConversationRow[] = [userRow("turn-1", 2), toolRow("turn-1", 3, "success")];

  assert.deepEqual(
    isRunningOf(rows, { sessionPhase: "completedSuccess", windowConnectedToTail: true }),
    [false],
  );
  assert.deepEqual(
    isRunningOf(rows, { sessionPhase: "completedInterrupted", windowConnectedToTail: true }),
    [false],
  );
});

test("轮头被裁掉：会话阶段未知时回退到行状态猜测（兼容旧投影）", () => {
  const gap: ConversationRow[] = [userRow("turn-1", 2), toolRow("turn-1", 3, "success")];
  const busy: ConversationRow[] = [userRow("turn-1", 2), toolRow("turn-1", 3, "running")];

  assert.deepEqual(isRunningOf(gap, { windowConnectedToTail: true }), [false]);
  assert.deepEqual(isRunningOf(busy, { windowConnectedToTail: true }), [true]);
});

test("会话运行态只归属窗口末轮：窗口里更早的缺轮头旧轮不判运行中", () => {
  const rows: ConversationRow[] = [
    userRow("turn-1", 2),
    toolRow("turn-1", 3, "success"),
    userRow("turn-2", 4),
    toolRow("turn-2", 5, "success"),
  ];

  assert.deepEqual(
    isRunningOf(rows, { sessionPhase: "running", windowConnectedToTail: true }),
    [false, true],
    "只有窗口末轮承接会话运行态",
  );
});

test("有轮头时仍以轮头为准：会话在跑也不能把已完成的轮顶成运行中", () => {
  const rows: ConversationRow[] = [
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
    toolRow("turn-1", 3, "success"),
  ];

  assert.deepEqual(
    isRunningOf(rows, { sessionPhase: "running", windowConnectedToTail: true }),
    [false],
    "轮头是权威，轮级语义不因会话运行态改变",
  );
});
