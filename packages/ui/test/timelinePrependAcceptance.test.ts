import assert from "node:assert/strict";
import test from "node:test";
import { splitPendingPageIntoBlockTurns } from "../src/v4/timelinePrependBlocks.js";
import { prependScrollAdjustment } from "../src/v4/timelineScrollAnchor.js";
import { timelineTopInsetAdjustment } from "../src/v4/timelinePrependCommit.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function row(rowId: number, turnId: string, kind = "assistantText"): ConversationRow {
  return { rowId, turnId, kind } as unknown as ConversationRow;
}

// 手机复现口径的数值仿真：补页 W（含完整轮 600px + 与窗口首轮缝合的整轮 300px），
// 窗口首轮旧渲染高 300px（被块收编后移出虚拟列表），占位块 56px 在提交帧消失。
// P3 给出 signed 差值与容器终值，P4 给出 scrollTop 前后；恒等式 applied = signed + inset。
const FULL_WHEEL_PX = 600;
const STITCHED_WHEEL_PX = 300;
const OLD_WINDOW_FIRST_PX = 300;
const SLOT_PX = 56;
const BLOCK_TOTAL_PX = FULL_WHEEL_PX + STITCHED_WHEEL_PX;

function signedTotalSizeDelta(): number {
  // 窗口首轮被块收编：虚拟列表反而变短，差值为负是正常的。
  const delta = prependScrollAdjustment({
    prevFirstRowId: 200,
    nextFirstRowId: 100,
    prevTotalSize: 1000,
    nextTotalSize: 1000 - OLD_WINDOW_FIRST_PX,
  });
  assert.notEqual(delta, null);
  return delta as number;
}

test("复现：跨页缝合页全量进块，不再有 trailing 走估算", () => {
  // W 页：T1 完整 + T2 半截（与窗口首轮同 turn，需缝合）。
  const page = [
    row(1, "turn-1", "turnHeader"),
    row(2, "turn-1"),
    row(3, "turn-2", "turnHeader"),
    row(4, "turn-2"),
  ];
  const result = splitPendingPageIntoBlockTurns(page, row(5, "turn-2"));
  assert.deepEqual(
    result.blockRows.map((r) => r.rowId),
    [1, 2, 3, 4],
  );
  assert.deepEqual(result.trailingRows, []);
});

test("对账 P3/P4：applied = 有符号差值 + inset 差值，正好是真增量", () => {
  const signed = signedTotalSizeDelta();
  assert.equal(signed, -OLD_WINDOW_FIRST_PX);
  // P3 的 blockCommitInsetPx：占位块已消失（0）+ 块容器终值（实测）。
  const blockCommitInsetPx = 0 + BLOCK_TOTAL_PX;
  // P3 的 inset 基线：占位块出现时的 56（appliedTopInset 旧值）。
  const inset = timelineTopInsetAdjustment(SLOT_PX, blockCommitInsetPx);
  const applied = signed + inset;
  // 真增量：完整轮 + 缝合轮 − 被收编的旧首轮 − 消失的占位块。
  const truth = FULL_WHEEL_PX + STITCHED_WHEEL_PX - OLD_WINDOW_FIRST_PX - SLOT_PX;
  assert.equal(applied, truth);
});

test("对照旧逻辑：钳非负会把收编段漏掉，X 被多补一段顶出去", () => {
  const signed = signedTotalSizeDelta();
  // 旧逻辑：delta > 0 ? delta : null，负值归 null 再归一成 0。
  const legacyAdjustment = signed > 0 ? signed : 0;
  const blockCommitInsetPx = 0 + BLOCK_TOTAL_PX;
  const inset = timelineTopInsetAdjustment(SLOT_PX, blockCommitInsetPx);
  const legacyApplied = legacyAdjustment + inset;
  const truth = FULL_WHEEL_PX + STITCHED_WHEEL_PX - OLD_WINDOW_FIRST_PX - SLOT_PX;
  assert.equal(legacyApplied - truth, OLD_WINDOW_FIRST_PX);
});

test("对齐页对照：无收编时差值为零，补偿只剩块实测减占位块", () => {
  const delta = prependScrollAdjustment({
    prevFirstRowId: 200,
    nextFirstRowId: 100,
    prevTotalSize: 1000,
    nextTotalSize: 1000,
  });
  assert.equal(delta, 0);
  const applied = (delta ?? 0) + timelineTopInsetAdjustment(SLOT_PX, FULL_WHEEL_PX);
  assert.equal(applied, FULL_WHEEL_PX - SLOT_PX);
});
