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
import type { ConversationTurnRenderUnitFrame } from "../src/v4/conversationTurnRenderUnits.js";

// 长历史滚动漂移的渲染侧根因：投影链每帧全量重算，所有 turn 的对象引用全换，
// ConversationTurnGroup 的浅比较全部失效。增量复用必须做到「输入没变的 turn
// 拿到同一个 unit 对象」，而判据要用行对象引用——applyConversationDeltas 只替换
// 被 delta 命中的那一个行对象，未命中的原样保留。

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

function textRow(turnId: string, rowId: number, text = "答复"): AssistantTextRow {
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

function toolRow(turnId: string, rowId: number, toolName = "Read"): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: `call-${rowId}`,
    toolName,
    status: "success",
    inputText: "",
    input: {},
  };
}

function runningToolRow(turnId: string, rowId: number): ToolCallRow {
  return { ...toolRow(turnId, rowId, "Bash"), status: "running" };
}

function unitsOf(frame: ConversationTurnRenderUnitFrame) {
  return frame.entries.map((entry) => entry.unit);
}

test("输入未变：所有 turn 复用同一个 unit 对象", () => {
  const rows: ConversationRow[] = [
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
    textRow("turn-1", 3),
    headerRow("turn-2", 4, "completedSuccess"),
    userRow("turn-2", 5),
    textRow("turn-2", 6),
  ];
  const first = buildConversationTurnRenderUnitFrame(rows, { nowMs: 1000 });
  // 换一个 rows 数组（每帧都会换），行对象全部复用——这正是 delta 帧的形状。
  const second = buildConversationTurnRenderUnitFrame([...rows], {
    nowMs: 1000,
    previousFrame: first,
  });

  const firstUnits = unitsOf(first);
  const secondUnits = unitsOf(second);
  assert.equal(firstUnits.length, 2);
  for (let index = 0; index < firstUnits.length; index += 1) {
    assert.equal(secondUnits[index], firstUnits[index], `turn #${index} 应复用同一对象`);
  }
});

test("只有被 delta 命中的那个 turn 换新对象，其余照旧复用", () => {
  const turnOneText = textRow("turn-1", 3);
  const rows: ConversationRow[] = [
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
    turnOneText,
    headerRow("turn-2", 4, "completedSuccess"),
    userRow("turn-2", 5),
    textRow("turn-2", 6),
  ];
  const first = buildConversationTurnRenderUnitFrame(rows, { nowMs: 1000 });

  // 只把 turn-1 的正文行换成新对象（流式追加就是这个形状）。
  const nextRows: ConversationRow[] = [...rows];
  nextRows[2] = textRow("turn-1", 3, "答复补一段");
  const second = buildConversationTurnRenderUnitFrame(nextRows, {
    nowMs: 1000,
    previousFrame: first,
  });

  const firstUnits = unitsOf(first);
  const secondUnits = unitsOf(second);
  assert.notEqual(secondUnits[0], firstUnits[0], "被改动的 turn 必须重算");
  assert.equal(secondUnits[1], firstUnits[1], "未改动的 turn 必须复用");
  assert.equal(secondUnits[0]?.latestAssistantTextRow?.text, "答复补一段");
});

test("每秒时钟 tick 只重算运行中的轮，完成的历史轮全部复用", () => {
  const rows: ConversationRow[] = [
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
    textRow("turn-1", 3),
    headerRow("turn-2", 4, "running"),
    userRow("turn-2", 5),
  ];
  const first = buildConversationTurnRenderUnitFrame(rows, { nowMs: 1000 });
  const second = buildConversationTurnRenderUnitFrame(rows, {
    nowMs: 2000,
    previousFrame: first,
  });

  const firstUnits = unitsOf(first);
  const secondUnits = unitsOf(second);
  assert.equal(firstUnits[0]?.isRunning, false);
  assert.equal(firstUnits[1]?.isRunning, true);
  // 这一条是本轮改动的核心：历史轮不再每秒重算。
  assert.equal(secondUnits[0], firstUnits[0], "完成轮与时钟无关，必须复用");
  assert.notEqual(secondUnits[1], firstUnits[1], "运行轮的工时吃 nowMs，必须重算");
  // 运行轮的秒数确实还在走。
  assert.equal(secondUnits[1]?.workStatus?.durationMs, 2000 - 1);
  assert.equal(secondUnits[0]?.workStatus?.durationMs, 1);
});

test("sessionPhase 变化：整体重算，不复用上一帧", () => {
  // 缺轮头的轮：isRunning 与异常展开都退回按 phase 裁决，才能看出 phase 真的进了投影。
  const rows: ConversationRow[] = [userRow("turn-1", 2), runningToolRow("turn-1", 3)];
  const first = buildConversationTurnRenderUnitFrame(rows, { sessionPhase: "streaming" });
  const second = buildConversationTurnRenderUnitFrame(rows, {
    sessionPhase: "completedInterrupted",
    previousFrame: first,
  });

  // phase 参与 isRunning 与异常展开判定，不是行的属性，复用判定覆盖不到，
  // 所以必须由 frame 自己记住并在 phase 变化时丢弃上一帧。
  assert.equal(unitsOf(first)[0]?.isRunning, true);
  assert.notEqual(unitsOf(second)[0], unitsOf(first)[0]);
  assert.equal(unitsOf(second)[0]?.isRunning, false);
  assert.equal(unitsOf(second)[0]?.assistantHistoryDefaultOpen, true);
});

test("轮头行换新对象（轮状态推进）时该轮重算", () => {
  const rows: ConversationRow[] = [headerRow("turn-1", 1, "running"), userRow("turn-1", 2)];
  const first = buildConversationTurnRenderUnitFrame(rows, { nowMs: 1000 });

  const nextRows: ConversationRow[] = [headerRow("turn-1", 1, "completedSuccess"), rows[1]!];
  const second = buildConversationTurnRenderUnitFrame(nextRows, {
    nowMs: 2000,
    previousFrame: first,
  });

  assert.notEqual(unitsOf(second)[0], unitsOf(first)[0]);
  assert.equal(unitsOf(second)[0]?.isRunning, false);
});

test("前插补页：已有 turn 内容复用，位置派生的 startsTimeline 重新落位", () => {
  const older: ConversationRow[] = [
    headerRow("turn-0", 10, "completedSuccess"),
    userRow("turn-0", 11),
    textRow("turn-0", 12),
  ];
  const window: ConversationRow[] = [
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
    textRow("turn-1", 3),
  ];
  const first = buildConversationTurnRenderUnitFrame(window, { nowMs: 1000 });
  const second = buildConversationTurnRenderUnitFrame([...older, ...window], {
    nowMs: 1000,
    previousFrame: first,
  });

  const firstUnits = unitsOf(first);
  const secondUnits = unitsOf(second);
  assert.equal(secondUnits.length, 2);
  assert.equal(secondUnits[0]?.turnId, "turn-0");
  // 补页只在前端换 rows 窗口里的数组，窗口内既有行的对象没被动过，行内容逐行相同。
  assert.deepEqual(secondUnits[1]?.renderRows, firstUnits[0]?.renderRows, "行内容应原样复用");
  // 但 turn-1 的 kept 下标从 0 变成 1，startsTimeline 必须跟着翻——轮顶 padding 由它决定，
  // 漏翻会让第二轮仍占着首轮的 56px 顶栏避让。所以这里拿到的是重新落位后的新对象。
  assert.equal(firstUnits[0]?.startsTimeline, true);
  assert.equal(secondUnits[1]?.startsTimeline, false, "原首轮不再占据首位，轮顶间距必须降下来");
  assert.equal(secondUnits[0]?.startsTimeline, true, "新前插的 turn-0 成为首轮");
});

test("位置未变的 turn 在前插后仍复用同一对象", () => {
  const older: ConversationRow[] = [
    headerRow("turn-0", 10, "completedSuccess"),
    userRow("turn-0", 11),
    textRow("turn-0", 12),
  ];
  // 首帧从 turn-1 起算：turn-1 在下标 0，turn-2 在下标 1。
  const window: ConversationRow[] = [
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
    textRow("turn-1", 3),
    headerRow("turn-2", 4, "completedSuccess"),
    userRow("turn-2", 5),
    textRow("turn-2", 6),
  ];
  const first = buildConversationTurnRenderUnitFrame(window, { nowMs: 1000 });
  const second = buildConversationTurnRenderUnitFrame([...older, ...window], {
    nowMs: 1000,
    previousFrame: first,
  });

  const firstUnits = unitsOf(first);
  const secondUnits = unitsOf(second);
  assert.equal(firstUnits[0]?.startsTimeline, true);
  assert.equal(firstUnits[1]?.startsTimeline, false);
  // 前插后 turn-1 让出首位（必须重新落位），turn-2 的下标仍是 1，位置没变。
  assert.equal(secondUnits[0]?.turnId, "turn-0");
  assert.equal(secondUnits[1]?.startsTimeline, false, "turn-1 已不是首轮");
  assert.equal(secondUnits[2], firstUnits[1], "位置未变的 turn 仍应复用同一对象");
});

test("不传 previousFrame 时结果与逐帧重算一致（首帧路径）", () => {
  const rows: ConversationRow[] = [
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
    toolRow("turn-1", 3),
    textRow("turn-1", 4),
  ];
  const cold = unitsOf(buildConversationTurnRenderUnitFrame(rows, { nowMs: 1000 }));
  const warmed = unitsOf(
    buildConversationTurnRenderUnitFrame(rows, {
      nowMs: 1000,
      previousFrame: buildConversationTurnRenderUnitFrame(rows, { nowMs: 1000 }),
    }),
  );

  assert.deepEqual(
    warmed.map((unit) => ({
      key: unit.key,
      isLastTurn: unit.isLastTurn,
      isRunning: unit.isRunning,
      historyOpen: unit.assistantHistoryDefaultOpen,
      flowKinds: unit.flowItems.map((item) => item.kind),
      text: unit.latestAssistantTextRow?.text,
    })),
    cold.map((unit) => ({
      key: unit.key,
      isLastTurn: unit.isLastTurn,
      isRunning: unit.isRunning,
      historyOpen: unit.assistantHistoryDefaultOpen,
      flowKinds: unit.flowItems.map((item) => item.kind),
      text: unit.latestAssistantTextRow?.text,
    })),
  );
});

test("最后一个 turn 的 isLastTurn 随窗口前插正确翻转", () => {
  const older: ConversationRow[] = [
    headerRow("turn-0", 10, "completedSuccess"),
    userRow("turn-0", 11),
  ];
  const tail: ConversationRow[] = [
    headerRow("turn-1", 1, "completedSuccess"),
    userRow("turn-1", 2),
  ];
  const first = buildConversationTurnRenderUnitFrame(tail, {});
  assert.equal(unitsOf(first)[0]?.isLastTurn, true);

  // turn-1 的行没变，但它的 kept 下标不再是末位，isLastTurn 必须跟着翻。
  const second = buildConversationTurnRenderUnitFrame([...older, ...tail], {
    previousFrame: first,
  });
  const secondUnits = unitsOf(second);
  assert.equal(secondUnits[0]?.isLastTurn, false);
  assert.equal(secondUnits[1]?.isLastTurn, true);
  // 落位变了但内容没变，不该整轮重物化。
  assert.equal(secondUnits[1]?.turnId, "turn-1");
});
