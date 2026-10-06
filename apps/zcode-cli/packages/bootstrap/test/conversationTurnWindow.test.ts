import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  resolveRowsRangeFrameBudgetBytes,
  selectAroundTurnWindow,
  selectNewerTurnWindow,
  selectOlderTurnWindow,
  selectTailTurnWindow,
} from "../src/zcode-protocol-v4/conversation-turn-window.js";

// 整轮取窗（docs/specs/conversation-timeline-turn-window-fill.md）：
// 页 = 整轮集合；页预算 = 单帧体积；只有整轮自身超预算才允许按行切分。

function row(rowId: number, turnId: string, kind = "assistantText"): ConversationRow {
  return { rowId, turnId, kind } as unknown as ConversationRow;
}

function turnRows(turnId: string, rowCount: number, startRowId: number): ConversationRow[] {
  return Array.from({ length: rowCount }, (_, index) => row(startRowId + index, turnId));
}

const jsonByteLength = (item: ConversationRow) => Buffer.byteLength(JSON.stringify(item), "utf8");

/**
 * 切片是否在指定边上落在轮边界。
 *
 * 补页方向的游标一侧**允许**是接缝：向上补页时页尾那一轮的剩余行已经在客户端窗口里，
 * 页首才是真正的「更早」边界；向下补页反之。首窗与跳转换窗两端都必须是真边界。
 */
function assertEdgeAligned(
  rows: readonly ConversationRow[],
  slice: { start: number; end: number },
  edge: "start" | "end",
): void {
  if (edge === "start") {
    const turnId = rows[slice.start]?.turnId;
    if (turnId === undefined) return;
    let index = slice.start;
    while (index > 0 && rows[index - 1]?.turnId === turnId) index -= 1;
    assert.equal(index, slice.start, `切片起点切在轮中间：turnId=${turnId}`);
    return;
  }
  const turnId = rows[slice.end - 1]?.turnId;
  if (turnId === undefined) return;
  let end = slice.end;
  while (end < rows.length && rows[end]?.turnId === turnId) end += 1;
  assert.equal(end, slice.end, `切片终点切在轮中间：turnId=${turnId}`);
}

test("尾窗：按整轮取到至少 minRows，两端都落在轮边界", () => {
  const rows = [
    ...turnRows("t1", 3, 1),
    ...turnRows("t2", 4, 4),
    ...turnRows("t3", 2, 8),
    ...turnRows("t4", 5, 10),
  ];
  const slice = selectTailTurnWindow(rows, { minRows: 6, byteBudget: 1024 * 1024 });
  // minRows=6 → 覆盖最后 6 行的最小整轮集合：t3+t4（7 行）。
  assert.deepEqual(
    rows.slice(slice.start, slice.end).map((item) => item.turnId),
    ["t3", "t3", "t4", "t4", "t4", "t4", "t4"],
  );
  assert.equal(slice.frameCapSplitTurnId, undefined);
  assertEdgeAligned(rows, slice, "start");
  assertEdgeAligned(rows, slice, "end");
});

test("尾窗：预算不够时整轮丢弃，且从不切轮", () => {
  const rows = [...turnRows("t1", 3, 1), ...turnRows("t2", 4, 4), ...turnRows("t3", 2, 8)];
  const budget = jsonByteLength(rows[7]!) + jsonByteLength(rows[8]!) + 1;
  const slice = selectTailTurnWindow(rows, { minRows: 1, byteBudget: budget });
  assert.deepEqual(
    rows.slice(slice.start, slice.end).map((item) => item.turnId),
    ["t3", "t3"],
  );
  assert.equal(slice.frameCapSplitTurnId, undefined);
});

test("尾窗：单轮自身超预算才拆轮，并带出 frameCapSplitTurnId", () => {
  const rows = turnRows("huge", 50, 1);
  const slice = selectTailTurnWindow(rows, {
    minRows: 50,
    byteBudget: jsonByteLength(rows[0]!) * 3,
  });
  assert.equal(slice.end, rows.length, "拆轮必须保留最新行");
  assert.ok(slice.end - slice.start <= 3);
  assert.equal(rows[slice.start]?.turnId, "huge");
  assert.equal(slice.frameCapSplitTurnId, "huge");
});

test("向上补页：游标所在轮带上前缀，再按整轮向上", () => {
  const rows = [
    ...turnRows("t1", 3, 1),
    ...turnRows("t2", 4, 4),
    ...turnRows("t3", 6, 8),
  ];
  const slice = selectOlderTurnWindow(rows, { beforeRowId: 10, byteBudget: 1024 * 1024 });
  // 游标 10 落在 t3 中段（rowId 8..13）：页 = t3 前缀 + t2 + t1 整轮；页尾接缝留给客户端窗口。
  assert.deepEqual(
    rows.slice(slice.start, slice.end).map((item) => item.rowId),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(slice.frameCapSplitTurnId, undefined);
  assertEdgeAligned(rows, slice, "start");
});

test("向上补页：预算只够一轮时停在该轮，不切轮", () => {
  const rows = [
    ...turnRows("t1", 3, 1),
    ...turnRows("t2", 4, 4),
    ...turnRows("t3", 6, 8),
  ];
  const budget = turnRows("t3", 6, 8).reduce((sum, item) => sum + jsonByteLength(item), 0);
  const slice = selectOlderTurnWindow(rows, { beforeRowId: 14, byteBudget: budget });
  assert.deepEqual(
    rows.slice(slice.start, slice.end).map((item) => item.turnId),
    ["t3", "t3", "t3", "t3", "t3", "t3"],
  );
  assert.equal(slice.frameCapSplitTurnId, undefined);
});

test("向上补页：游标之前没有行时返回空切片", () => {
  const rows = turnRows("t1", 3, 1);
  const slice = selectOlderTurnWindow(rows, { beforeRowId: 1, byteBudget: 1024 });
  assert.equal(slice.end - slice.start, 0);
});

test("向下补页：游标所在轮带上后缀，再按整轮向下", () => {
  const rows = [
    ...turnRows("t1", 3, 1),
    ...turnRows("t2", 4, 4),
    ...turnRows("t3", 2, 8),
  ];
  const slice = selectNewerTurnWindow(rows, { afterRowId: 5, byteBudget: 1024 * 1024 });
  // 游标 5 落在 t2 中段（rowId 4..7）：页 = t2 后半截 + t3 整轮；页首是接缝。
  assert.deepEqual(
    rows.slice(slice.start, slice.end).map((item) => item.rowId),
    [6, 7, 8, 9],
  );
  assert.equal(slice.frameCapSplitTurnId, undefined);
  assertEdgeAligned(rows, slice, "end");
});

test("向下补页：游标之后没有行时返回空切片", () => {
  const rows = turnRows("t1", 3, 1);
  const slice = selectNewerTurnWindow(rows, { afterRowId: 3, byteBudget: 1024 });
  assert.equal(slice.end - slice.start, 0);
});

test("跳转换窗：目标轮整轮在内，且两端都是真轮边界", () => {
  const rows = [
    ...turnRows("t1", 3, 1),
    ...turnRows("t2", 4, 4),
    ...turnRows("t3", 2, 8),
    ...turnRows("t4", 5, 10),
  ];
  const slice = selectAroundTurnWindow(rows, { aroundRowId: 9, byteBudget: 1024 * 1024 });
  assert.notEqual(slice, null);
  const picked = rows.slice(slice!.start, slice!.end).map((item) => item.rowId);
  assert.ok(picked.includes(8), "目标轮必须完整（turnHeader 行 8 在内）");
  assert.ok(picked.includes(9));
  assert.ok(picked.includes(10));
  assertEdgeAligned(rows, slice!, "start");
  assertEdgeAligned(rows, slice!, "end");
});

test("跳转换窗：目标行不在投影内返回 null（不猜位置）", () => {
  const rows = turnRows("t1", 3, 1);
  assert.equal(selectAroundTurnWindow(rows, { aroundRowId: 999, byteBudget: 1024 }), null);
});

test("跳转换窗：目标轮超预算时按行切，且区间仍包含目标行", () => {
  const rows = turnRows("huge", 40, 1);
  const slice = selectAroundTurnWindow(rows, {
    aroundRowId: 20,
    byteBudget: jsonByteLength(rows[0]!) * 4,
  });
  assert.notEqual(slice, null);
  const picked = rows.slice(slice!.start, slice!.end).map((item) => item.rowId);
  assert.ok(picked.includes(20), "目标行必须落在切出的区间内");
  assert.ok(picked.length <= 4);
  assert.equal(slice!.frameCapSplitTurnId, "huge");
});

test("页预算来自单帧上限减去信封预留", () => {
  const budget = resolveRowsRangeFrameBudgetBytes();
  assert.ok(budget > 0);
  assert.ok(budget < 1024 * 1024, "预算必须为信封留出余量，不能等于整帧上限");
});