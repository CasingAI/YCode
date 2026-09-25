import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveTimelineUserScrollAnchorAdjustment,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldShowTimelineHistoryLoading,
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

test("历史加载提示只在有更多历史且请求在途时显示", () => {
  assert.equal(shouldShowTimelineHistoryLoading({ loadingOlder: true, canLoadOlder: true }), true);
  assert.equal(
    shouldShowTimelineHistoryLoading({ loadingOlder: false, canLoadOlder: true }),
    false,
  );
  assert.equal(
    shouldShowTimelineHistoryLoading({ loadingOlder: true, canLoadOlder: false }),
    false,
  );
  assert.equal(
    shouldShowTimelineHistoryLoading({ loadingOlder: false, canLoadOlder: false }),
    false,
  );
});
