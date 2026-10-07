import assert from "node:assert/strict";
import test from "node:test";
import {
  isTimelinePrependFillCommitReady,
  isTimelinePrependFillTurnAligned,
  isTimelineWindowFillComplete,
  shouldContinueTimelinePrependFill,
  shouldContinueTimelineWindowFill,
  shouldShowTimelineLoadingHint,
} from "../src/v4/timelineWindowFill.js";

// 静默补齐停止条件（docs/specs/conversation-timeline-turn-window-fill.md）：
// 折叠铺满一屏，或没有更早历史——只有这两种。

const base = {
  stagedHeightPx: 400,
  viewportHeightPx: 800,
  hasMoreOlder: true,
  fetchingOlder: false,
};

test("不足一屏且还有更早历史：未完成，需继续取页", () => {
  assert.equal(isTimelineWindowFillComplete(base), false);
  assert.equal(shouldContinueTimelineWindowFill(base), true);
});

test("折叠高度恰好等于视口：算铺满，不再多取一页", () => {
  const input = { ...base, stagedHeightPx: 800 };
  assert.equal(isTimelineWindowFillComplete(input), true);
  assert.equal(shouldContinueTimelineWindowFill(input), false);
});

test("没有更早历史：完成（不论高度）", () => {
  const input = { ...base, hasMoreOlder: false, stagedHeightPx: 10 };
  assert.equal(isTimelineWindowFillComplete(input), true);
  assert.equal(shouldContinueTimelineWindowFill(input), false);
});

test("取数在途时不重复发请求（避免自旋）", () => {
  const input = { ...base, fetchingOlder: true };
  assert.equal(shouldContinueTimelineWindowFill(input), false);
  assert.equal(isTimelineWindowFillComplete(input), false);
});

test("缓冲未提交不算在途：第一页落地后仍要能发出第二页请求", () => {
  // 单飞信号必须只认「请求在途」。若拿「补齐事务未完结」当在途，第一页落地后
  // 补齐循环就再也不会发第二次请求，永远补不到一屏。
  assert.equal(shouldContinueTimelineWindowFill(base), true);
});

test("尚未排版出高度（staged=0）不算完成，也不触发取页", () => {
  // staged 高度 0 既不是「够一屏」，也不能据此判断「装不下」——等排版回调。
  const input = { ...base, stagedHeightPx: 0 };
  assert.equal(isTimelineWindowFillComplete(input), false);
  assert.equal(shouldContinueTimelineWindowFill(input), false);
});

test("视口高度未知时不判定完成", () => {
  assert.equal(isTimelineWindowFillComplete({ ...base, viewportHeightPx: 0 }), false);
});

test("加载提示：补齐进行中超过延迟才显示，快链路全程透明", () => {
  assert.equal(
    shouldShowTimelineLoadingHint({
      pending: true,
      elapsedMs: 399,
      delayMs: 400,
    }),
    false,
  );
  assert.equal(
    shouldShowTimelineLoadingHint({
      pending: true,
      elapsedMs: 400,
      delayMs: 400,
    }),
    true,
  );
  assert.equal(
    shouldShowTimelineLoadingHint({
      pending: false,
      elapsedMs: 999,
      delayMs: 400,
    }),
    false,
  );
});

// 上滚补页的填充条件（turn-window-fill 规则 11）：铺满一屏「且」整轮到齐，
// 或没有更早历史。与首绘共用高度语义，多出整轮这一维。

const prependBase = {
  stagedHeightPx: 800,
  viewportHeightPx: 800,
  hasMoreOlder: true,
  fetchingOlder: false,
  bufferOldestRowKind: "turnHeader" as string | null,
};

test("整轮到齐：最老行是 turnHeader 即到齐", () => {
  assert.equal(
    isTimelinePrependFillTurnAligned({
      bufferOldestRowKind: "turnHeader",
      hasMoreOlder: true,
    }),
    true,
  );
});

test("整轮未到齐：最老行是巨轮拆轮中段（toolCall）", () => {
  assert.equal(
    isTimelinePrependFillTurnAligned({
      bufferOldestRowKind: "toolCall",
      hasMoreOlder: true,
    }),
    false,
  );
});

test("没有更早历史即视为到齐（不论最老行 kind）", () => {
  assert.equal(
    isTimelinePrependFillTurnAligned({
      bufferOldestRowKind: "toolCall",
      hasMoreOlder: false,
    }),
    true,
  );
});

test("缓冲为空时视为到齐：守门交给高度条件", () => {
  assert.equal(
    isTimelinePrependFillTurnAligned({
      bufferOldestRowKind: null,
      hasMoreOlder: true,
    }),
    true,
  );
  // 缓冲空 = staged 还没排版（高度 0），提交不就绪、也不取页（等排版回调）。
  const input = {
    ...prependBase,
    bufferOldestRowKind: null,
    stagedHeightPx: 0,
  };
  assert.equal(isTimelinePrependFillCommitReady(input), false);
  assert.equal(shouldContinueTimelinePrependFill(input), false);
});

test("铺满一屏且整轮到齐：提交就绪", () => {
  assert.equal(isTimelinePrependFillCommitReady(prependBase), true);
  assert.equal(shouldContinueTimelinePrependFill(prependBase), false);
});

test("铺满一屏但边界轮未到齐（巨轮拆轮中段）：不提交，继续静默取页", () => {
  // 这正是「工具 N 次」当面上涨要拦的场景：高度够了但同轮更早的行还没取回来。
  const input = { ...prependBase, bufferOldestRowKind: "toolCall" };
  assert.equal(isTimelinePrependFillCommitReady(input), false);
  assert.equal(shouldContinueTimelinePrependFill(input), true);
});

test("整轮到齐但不足一屏：不提交，继续静默取页", () => {
  const input = { ...prependBase, stagedHeightPx: 799 };
  assert.equal(isTimelinePrependFillCommitReady(input), false);
  assert.equal(shouldContinueTimelinePrependFill(input), true);
});

test("没有更早历史：直接就绪（不论高度与轮对齐）", () => {
  const input = {
    ...prependBase,
    hasMoreOlder: false,
    stagedHeightPx: 30,
    bufferOldestRowKind: "toolCall" as string | null,
  };
  assert.equal(isTimelinePrependFillCommitReady(input), true);
  assert.equal(shouldContinueTimelinePrependFill(input), false);
});

test("取数在途时填充循环不重复发请求", () => {
  const input = {
    ...prependBase,
    stagedHeightPx: 100,
    bufferOldestRowKind: "toolCall" as string | null,
    fetchingOlder: true,
  };
  assert.equal(isTimelinePrependFillCommitReady(input), false);
  assert.equal(shouldContinueTimelinePrependFill(input), false);
});

test("视口高度未知时既不就绪也不取页", () => {
  const input = { ...prependBase, viewportHeightPx: 0 };
  assert.equal(isTimelinePrependFillCommitReady(input), false);
  assert.equal(shouldContinueTimelinePrependFill(input), false);
});
