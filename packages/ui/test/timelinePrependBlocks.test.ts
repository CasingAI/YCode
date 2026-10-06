import assert from "node:assert/strict";
import test from "node:test";
import { splitPendingPageIntoBlockTurns } from "../src/v4/timelinePrependBlocks.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function row(rowId: number, turnId: string, kind = "assistantText"): ConversationRow {
  // 只填切分依赖的字段；其余字段对纯函数不可见。
  return { rowId, turnId, kind } as unknown as ConversationRow;
}

const T1 = "turn-1";
const T2 = "turn-2";
const T3 = "turn-3";

test("空页返回空块空尾，允许 Δ=0 提交", () => {
  const result = splitPendingPageIntoBlockTurns([], row(1, T1));
  assert.deepEqual(result, { blockRows: [], trailingRows: [] });
});

test("全量进块：页内完整 turn 不再留尾巴", () => {
  // T1 完整（header + 正文）、T2 完整；窗口首行是 T3。
  const page = [row(1, T1, "turnHeader"), row(2, T1), row(3, T2, "turnHeader"), row(4, T2)];
  const result = splitPendingPageIntoBlockTurns(page, row(5, T3, "turnHeader"));
  assert.deepEqual(
    result.blockRows.map((r) => r.rowId),
    [1, 2, 3, 4],
  );
  assert.deepEqual(result.trailingRows, []);
});

test("全量进块：页尾 turn 延续到窗口首行也进块（缝合成整轮再量）", () => {
  // T2 的后半截在本页，前半截在窗口里：拼好后的整轮在块里合练，不走估算。
  const page = [row(1, T1, "turnHeader"), row(2, T1), row(3, T2, "turnHeader"), row(4, T2)];
  const result = splitPendingPageIntoBlockTurns(page, row(5, T2));
  assert.deepEqual(
    result.blockRows.map((r) => r.rowId),
    [1, 2, 3, 4],
  );
  assert.deepEqual(result.trailingRows, []);
});

test("全量进块：页首 turn 中段也进块", () => {
  // 页首两行属于被上一页截断的 T0，没有 header：同样进块合练。
  const page = [row(1, "turn-0"), row(2, "turn-0"), row(3, T1, "turnHeader"), row(4, T1)];
  const result = splitPendingPageIntoBlockTurns(page, row(5, T2, "turnHeader"));
  assert.deepEqual(
    result.blockRows.map((r) => r.rowId),
    [1, 2, 3, 4],
  );
  assert.deepEqual(result.trailingRows, []);
});

test("全量进块：整页没有 turnHeader 也进块", () => {
  const page = [row(1, T1), row(2, T1)];
  const result = splitPendingPageIntoBlockTurns(page, row(3, T2, "turnHeader"));
  assert.deepEqual(
    result.blockRows.map((r) => r.rowId),
    [1, 2],
  );
  assert.deepEqual(result.trailingRows, []);
});

test("全量进块：中段 + 完整 + 跨页同页共存时不丢行", () => {
  const page = [
    row(1, "turn-0"), // 中段（无 header）
    row(2, T1, "turnHeader"), // T1 完整
    row(3, T1),
    row(4, T2, "turnHeader"), // T2 跨页：延续到窗口首行
    row(5, T2),
  ];
  const result = splitPendingPageIntoBlockTurns(page, row(6, T2));
  assert.deepEqual(
    result.blockRows.map((r) => r.rowId),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(result.trailingRows, []);
});

test("窗口为空（冷启动全量并入）：整页进块", () => {
  const page = [row(1, T1, "turnHeader"), row(2, T1), row(3, T2, "turnHeader")];
  const result = splitPendingPageIntoBlockTurns(page, undefined);
  assert.deepEqual(
    result.blockRows.map((r) => r.rowId),
    [1, 2, 3],
  );
  assert.deepEqual(result.trailingRows, []);
});

test("切分保持 rowId 升序且不丢行：block 即原页", () => {
  const page = [
    row(1, "turn-0"),
    row(2, T1, "turnHeader"),
    row(3, T1),
    row(4, T2, "turnHeader"),
    row(5, T2),
  ];
  const result = splitPendingPageIntoBlockTurns(page, row(6, T2));
  assert.deepEqual(
    result.blockRows.map((r) => r.rowId),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(result.trailingRows, []);
});

test("单行 turnHeader 的孤立 turn 也进块", () => {
  const page = [row(1, T1, "turnHeader")];
  const result = splitPendingPageIntoBlockTurns(page, row(2, T2, "turnHeader"));
  assert.deepEqual(
    result.blockRows.map((r) => r.rowId),
    [1],
  );
  assert.deepEqual(result.trailingRows, []);
});
