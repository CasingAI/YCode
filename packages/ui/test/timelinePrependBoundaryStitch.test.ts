import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildConversationTurnRenderUnits } from "../src/v4/conversationTurnRenderUnits.js";
import { stitchPendingPageBoundaryTurn } from "../src/v4/timelinePrependBlocks.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

const CREATED_AT = 1_700_000_000_000;

function base(rowId: number, turnId: string) {
  return { rowId, turnId, createdAt: CREATED_AT, createdAtSeq: rowId };
}

function turnHeader(rowId: number, turnId: string): ConversationRow {
  return {
    ...base(rowId, turnId),
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "completedSuccess",
    startedAt: CREATED_AT,
  } as unknown as ConversationRow;
}

function userInput(rowId: number, turnId: string): ConversationRow {
  return {
    ...base(rowId, turnId),
    kind: "userInput",
    text: "干活",
    origin: "realUser",
  } as unknown as ConversationRow;
}

function toolCall(rowId: number, turnId: string): ConversationRow {
  return {
    ...base(rowId, turnId),
    kind: "toolCall",
    toolCallId: `tc-${rowId}`,
    toolName: "Read",
    status: "success",
    inputText: "{}",
  } as unknown as ConversationRow;
}

function assistantText(rowId: number, turnId: string): ConversationRow {
  return {
    ...base(rowId, turnId),
    kind: "assistantText",
    text: "做完了",
    state: "complete",
  } as unknown as ConversationRow;
}

const LONG_TURN = "turn-long";

/**
 * 一条长轮被补页与窗口切成两半：轮头在补页里，轮尾（过程行 + 最终正文）在窗口里。
 *
 *   rowId 1 turnHeader ─┐
 *   rowId 2 userInput   ├─ 补页（更早）
 *   rowId 3 toolCall    │
 *   rowId 4 toolCall   ─┘
 *   rowId 5 toolCall   ─┐
 *   rowId 6 assistantText ─┴ 窗口（更新）
 */
const PAGE_ROWS: readonly ConversationRow[] = [
  turnHeader(1, LONG_TURN),
  userInput(2, LONG_TURN),
  toolCall(3, LONG_TURN),
  toolCall(4, LONG_TURN),
];
const WINDOW_ROWS: readonly ConversationRow[] = [
  toolCall(5, LONG_TURN),
  assistantText(6, LONG_TURN),
];

function defaultOpenOf(rows: readonly ConversationRow[]): boolean {
  const units = buildConversationTurnRenderUnits(rows, { sessionPhase: "completedSuccess" });
  assert.equal(units.length, 1);
  return units[0]!.assistantHistoryDefaultOpen;
}

test("前提：只拿轮头建帧会被判成展开（这正是必须缝合的原因）", () => {
  // 轮头没有最终正文 → 折叠规则读成「仍在进行」→ 过程区默认展开。
  assert.equal(defaultOpenOf(PAGE_ROWS), true);
  // 轮尾到齐后同一轮已完成 → 过程区收起。
  assert.equal(defaultOpenOf([...PAGE_ROWS, ...WINDOW_ROWS]), false);
});

test("缝合：暗处合练的行集必须补齐边界轮在窗口里的后半截", () => {
  const stitched = stitchPendingPageBoundaryTurn(PAGE_ROWS, WINDOW_ROWS);
  assert.deepEqual(
    stitched.map((row) => row.rowId),
    [1, 2, 3, 4, 5, 6],
  );
});

test("缝合后暗处预渲染与提交后的折叠判定一致", () => {
  const stitched = stitchPendingPageBoundaryTurn(PAGE_ROWS, WINDOW_ROWS);
  assert.equal(defaultOpenOf(stitched), defaultOpenOf([...PAGE_ROWS, ...WINDOW_ROWS]));
  assert.equal(defaultOpenOf(stitched), false);
});

test("缝合：窗口首轮与补页末轮不同轮时不缝合", () => {
  const otherWindow: readonly ConversationRow[] = [
    turnHeader(7, "turn-other"),
    assistantText(8, "turn-other"),
  ];
  const stitched = stitchPendingPageBoundaryTurn(PAGE_ROWS, otherWindow);
  assert.deepEqual(
    stitched.map((row) => row.rowId),
    [1, 2, 3, 4],
  );
});

test("缝合：窗口为空（冷启动）时不缝合", () => {
  const stitched = stitchPendingPageBoundaryTurn(PAGE_ROWS, []);
  assert.deepEqual(
    stitched.map((row) => row.rowId),
    [1, 2, 3, 4],
  );
});

test("缝合：补页为空时不缝合", () => {
  const stitched = stitchPendingPageBoundaryTurn([], WINDOW_ROWS);
  assert.deepEqual(stitched, []);
});

const timelineSource = readFileSync(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);

test("接线：暗处帧必须用缝合后的行集建帧", () => {
  // 缝合函数存在却没接到建帧上，是这条修复最容易出现的退化：判定一致但折叠仍旧翻转。
  assert.match(
    timelineSource,
    /const stagedPrependRows = useMemo\(\s*\(\) =>\s*stitchPendingPageBoundaryTurn\(stagedPageSplit\.blockRows, rows\),/,
    "暗处合练的行集必须由缝合函数产出",
  );
  assert.match(
    timelineSource,
    /buildConversationTurnRenderUnitFrame\(stagedPrependRows, \{/,
    "暗处帧必须用缝合后的行集建帧，不能用只含轮头的补页行",
  );
  assert.doesNotMatch(
    timelineSource,
    /buildConversationTurnRenderUnitFrame\(stagedPageSplit\.blockRows, \{/,
    "暗处帧不得再直接用只含轮头的补页行建帧",
  );
});
