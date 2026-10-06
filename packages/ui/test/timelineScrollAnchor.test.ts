import assert from "node:assert/strict";
import test from "node:test";
import {
  prependScrollAdjustment,
  resolveTimelineUserScrollAnchorAdjustment,
  shouldAdjustVirtualizerForItemSizeChange,
} from "../src/v4/timelineScrollAnchor.js";

const baseAdjustmentInput = {
  following: false,
  suppressAdjustment: false,
  contentWidthChanging: false,
  userScrollProtected: false,
  itemEnd: 100,
  scrollTop: 200,
};

test("用户滚动保护期间禁止 virtualizer 直接补偿测高", () => {
  assert.equal(
    shouldAdjustVirtualizerForItemSizeChange({
      ...baseAdjustmentInput,
      userScrollProtected: true,
    }),
    false,
  );
});

test("没有用户滚动保护时保留视口上方行的既有补偿判据", () => {
  assert.equal(shouldAdjustVirtualizerForItemSizeChange(baseAdjustmentInput), true);
  assert.equal(
    shouldAdjustVirtualizerForItemSizeChange({
      ...baseAdjustmentInput,
      itemEnd: 201,
    }),
    false,
  );
});

test("following、恢复和宽度变化继续优先抑制测高补偿", () => {
  for (const override of [
    { following: true },
    { suppressAdjustment: true },
    { contentWidthChanging: true },
  ]) {
    assert.equal(
      shouldAdjustVirtualizerForItemSizeChange({
        ...baseAdjustmentInput,
        ...override,
      }),
      false,
    );
  }
});

test("稳定用户锚点按新 measurement 起点计算一次校正量", () => {
  assert.equal(
    resolveTimelineUserScrollAnchorAdjustment({
      anchor: { key: "turn-a", offsetTop: 40 },
      nextKey: "turn-a",
      nextStart: 1240,
      scrollTop: 1000,
    }),
    200,
  );
});

test("用户锚点 key 改变时拒绝使用旧位置", () => {
  assert.equal(
    resolveTimelineUserScrollAnchorAdjustment({
      anchor: { key: "turn-a", offsetTop: 40 },
      nextKey: "turn-b",
      nextStart: 1240,
      scrollTop: 1000,
    }),
    null,
  );
});

test("用户锚点数值非法时拒绝猜测校正", () => {
  for (const input of [
    {
      anchor: { key: "turn-a", offsetTop: Number.NaN },
      nextKey: "turn-a",
      nextStart: 1240,
      scrollTop: 1000,
    },
    {
      anchor: { key: "turn-a", offsetTop: 40 },
      nextKey: "turn-a",
      nextStart: Number.POSITIVE_INFINITY,
      scrollTop: 1000,
    },
    {
      anchor: { key: "turn-a", offsetTop: 40 },
      nextKey: "turn-a",
      nextStart: 1240,
      scrollTop: Number.NaN,
    },
  ]) {
    assert.equal(resolveTimelineUserScrollAnchorAdjustment(input), null);
  }
});

test("历史前插 keyed measurement 缺失时保留总高度 fallback（有符号原始差值）", () => {
  assert.equal(
    prependScrollAdjustment({
      prevFirstRowId: 100,
      nextFirstRowId: 50,
      prevTotalSize: 1000,
      nextTotalSize: 1600,
    }),
    600,
  );
  assert.equal(
    prependScrollAdjustment({
      prevFirstRowId: 100,
      nextFirstRowId: 100,
      prevTotalSize: 1000,
      nextTotalSize: 1600,
    }),
    null,
  );
  // 全量进块后窗口首轮被块收编，虚拟列表反而变短：负差值是正常的，
  // 调用方把它与 inset 实测增量合成一笔，正负相抵后正好是真增量。
  assert.equal(
    prependScrollAdjustment({
      prevFirstRowId: 100,
      nextFirstRowId: 50,
      prevTotalSize: 1600,
      nextTotalSize: 1000,
    }),
    -600,
  );
});
