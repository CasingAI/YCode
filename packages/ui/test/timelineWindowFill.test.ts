import assert from "node:assert/strict";
import test from "node:test";
import {
  isTimelineWindowFillComplete,
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
    shouldShowTimelineLoadingHint({ pending: true, elapsedMs: 399, delayMs: 400 }),
    false,
  );
  assert.equal(
    shouldShowTimelineLoadingHint({ pending: true, elapsedMs: 400, delayMs: 400 }),
    true,
  );
  assert.equal(
    shouldShowTimelineLoadingHint({ pending: false, elapsedMs: 999, delayMs: 400 }),
    false,
  );
});
