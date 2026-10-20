import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSwipeGesture,
  createSwipeGestureState,
  isHorizontallyScrollableContainer,
  resolveSwipeAxis,
  resolveSwipeOpenThresholdPx,
  shouldOpenSidebarFromSwipe,
  SWIPE_DIRECTION_LOCK_DISTANCE_PX,
  SWIPE_OPEN_MIN_DISTANCE_PX,
  SWIPE_OPEN_MIN_VIEWPORT_RATIO,
} from "../src/app-shell/workspaceShellSwipeGesture.js";

test("方向仲裁：位移不足锁定距离时不判方向", () => {
  assert.equal(
    resolveSwipeAxis({ deltaX: SWIPE_DIRECTION_LOCK_DISTANCE_PX - 1, deltaY: 0 }),
    "undecided",
  );
  assert.equal(
    resolveSwipeAxis({
      deltaX: SWIPE_DIRECTION_LOCK_DISTANCE_PX - 1,
      deltaY: SWIPE_DIRECTION_LOCK_DISTANCE_PX - 1,
    }),
    "undecided",
  );
});

test("方向仲裁：横向分量占优判横向，纵向占优判纵向", () => {
  assert.equal(resolveSwipeAxis({ deltaX: 40, deltaY: 10 }), "horizontal");
  assert.equal(resolveSwipeAxis({ deltaX: 10, deltaY: 40 }), "vertical");
  // 斜向按绝对值比较，两分量相等时判横向（>=）。
  assert.equal(resolveSwipeAxis({ deltaX: 30, deltaY: -30 }), "horizontal");
  assert.equal(resolveSwipeAxis({ deltaX: -30, deltaY: 30 }), "horizontal");
});

test("方向仲裁：只看绝对值，向左的横滑同样锁定为横向", () => {
  // 符号交给调用方判断「是不是往右」：这里只负责把方向轴定下来。
  assert.equal(resolveSwipeAxis({ deltaX: -40, deltaY: -10 }), "horizontal");
});

test("阈值：取固定下限与视口比例的较大值", () => {
  // 小屏：比例项低于固定下限，取固定下限。
  assert.equal(resolveSwipeOpenThresholdPx({ viewportWidthPx: 320 }), SWIPE_OPEN_MIN_DISTANCE_PX);
  assert.equal(resolveSwipeOpenThresholdPx({ viewportWidthPx: 384 }), SWIPE_OPEN_MIN_DISTANCE_PX);
  // 390px：25% 是 97.5，取整 98，已经越过固定下限。
  assert.equal(resolveSwipeOpenThresholdPx({ viewportWidthPx: 390 }), 98);
  // 大屏：比例项超过固定下限，取比例项。
  assert.equal(
    resolveSwipeOpenThresholdPx({ viewportWidthPx: 1000 }),
    Math.round(1000 * SWIPE_OPEN_MIN_VIEWPORT_RATIO),
  );
});

test("阈值：390px 视口下是 98px（25% 取整）", () => {
  assert.equal(resolveSwipeOpenThresholdPx({ viewportWidthPx: 390 }), 98);
});

test("触发判定：净右移量必须达到阈值", () => {
  const viewportWidthPx = 390;
  assert.equal(
    shouldOpenSidebarFromSwipe({ deltaX: 97, viewportWidthPx }),
    false,
  );
  assert.equal(shouldOpenSidebarFromSwipe({ deltaX: 98, viewportWidthPx }), true);
});

test("触发判定：向左一律不触发（本次只做打开方向）", () => {
  assert.equal(
    shouldOpenSidebarFromSwipe({ deltaX: -200, viewportWidthPx: 390 }),
    false,
  );
  assert.equal(shouldOpenSidebarFromSwipe({ deltaX: 0, viewportWidthPx: 390 }), false);
});

test("触发判定：可以用外部阈值覆盖", () => {
  assert.equal(
    shouldOpenSidebarFromSwipe({ deltaX: 50, viewportWidthPx: 390, thresholdPx: 40 }),
    true,
  );
  assert.equal(
    shouldOpenSidebarFromSwipe({ deltaX: 50, viewportWidthPx: 390, thresholdPx: 60 }),
    false,
  );
});

test("横向滚动容器判定：必须同时满足 overflow-x 可滚动与内容确实超宽", () => {
  // 代码块未开自动换行：长行超宽 → 算滚动容器。
  assert.equal(
    isHorizontallyScrollableContainer({
      scrollWidth: 900,
      clientWidth: 300,
      overflowX: "scroll",
    }),
    true,
  );
  // 开了自动换行：内容不再超宽 → 不算滚动容器，滑动应当打开侧栏。
  assert.equal(
    isHorizontallyScrollableContainer({
      scrollWidth: 300,
      clientWidth: 300,
      overflowX: "scroll",
    }),
    false,
  );
  // overflow-x 是 hidden：内容超宽但不可滚，不算。
  assert.equal(
    isHorizontallyScrollableContainer({
      scrollWidth: 900,
      clientWidth: 300,
      overflowX: "hidden",
    }),
    false,
  );
  // overflow-x 是 visible：同上。
  assert.equal(
    isHorizontallyScrollableContainer({
      scrollWidth: 900,
      clientWidth: 300,
      overflowX: "visible",
    }),
    false,
  );
  // 1px 的舍入误差不算超宽。
  assert.equal(
    isHorizontallyScrollableContainer({
      scrollWidth: 301,
      clientWidth: 300,
      overflowX: "auto",
    }),
    false,
  );
});

test("状态机：位移不足锁定距离时保持未决", () => {
  const state = advanceSwipeGesture({
    state: createSwipeGestureState(),
    deltaX: 3,
    deltaY: 2,
    viewportWidthPx: 390,
  });
  assert.equal(state.axis, "undecided");
  assert.equal(state.abandoned, false);
  assert.equal(state.pendingOpen, false);
});

test("状态机：锁定为纵向后整个序列作废", () => {
  const state = advanceSwipeGesture({
    state: createSwipeGestureState(),
    deltaX: 4,
    deltaY: 60,
    viewportWidthPx: 390,
  });
  assert.equal(state.axis, "vertical");
  assert.equal(state.abandoned, true);
  assert.equal(state.pendingOpen, false);
});

test("状态机：锁定为横向但向左时作废（本次只做打开方向）", () => {
  const state = advanceSwipeGesture({
    state: createSwipeGestureState(),
    deltaX: -60,
    deltaY: 4,
    viewportWidthPx: 390,
  });
  assert.equal(state.axis, "horizontal");
  assert.equal(state.abandoned, true);
  assert.equal(state.pendingOpen, false);
});

test("状态机：横向累计但未达阈值时不提交", () => {
  const state = advanceSwipeGesture({
    state: createSwipeGestureState(),
    deltaX: 90,
    deltaY: 2,
    viewportWidthPx: 390,
  });
  assert.equal(state.axis, "horizontal");
  assert.equal(state.abandoned, false);
  assert.equal(state.pendingOpen, false);
});

test("状态机：越过阈值只标记待打开，不当场提交", () => {
  const state = advanceSwipeGesture({
    state: createSwipeGestureState(),
    deltaX: 120,
    deltaY: 2,
    viewportWidthPx: 390,
  });
  assert.equal(state.axis, "horizontal");
  assert.equal(state.pendingOpen, true);
  // 越过后不再处理后续移动，避免重复提交。
  assert.equal(state.abandoned, true);
});

test("状态机：已作废的状态推进后原样返回", () => {
  const abandoned = advanceSwipeGesture({
    state: createSwipeGestureState(),
    deltaX: 4,
    deltaY: 60,
    viewportWidthPx: 390,
  });
  const next = advanceSwipeGesture({
    state: abandoned,
    deltaX: 400,
    deltaY: 0,
    viewportWidthPx: 390,
  });
  assert.equal(next, abandoned);
  assert.equal(next.pendingOpen, false);
});

test("状态机：斜向滑动不会误触发", () => {
  // 右下斜划：横向分量够大但纵向也大，锁定横向后净右移量达不到阈值。
  const state = advanceSwipeGesture({
    state: createSwipeGestureState(),
    deltaX: 80,
    deltaY: 70,
    viewportWidthPx: 390,
  });
  assert.equal(state.axis, "horizontal");
  assert.equal(state.pendingOpen, false);
});
