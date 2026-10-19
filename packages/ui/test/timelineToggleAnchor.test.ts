import assert from "node:assert/strict";
import test from "node:test";
import {
  TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR,
  TIMELINE_TOGGLE_ANCHOR_MAX_WINDOW_MS,
  TIMELINE_TOGGLE_ANCHOR_WINDOW_MS,
  extendedTimelineToggleAnchorDelayMs,
  isTimelineToggleAnchorDetached,
  resolveTimelineContentAnchorAction,
  shouldCompensateTimelineToggleAnchorOnScroll,
  shouldReleaseToggleAnchorOnUserScroll,
  shouldSuppressTimelineScrollToBottom,
  timelineToggleAnchorAdjustment,
  timelineToggleAnchorContentAdjustment,
  timelineToggleAnchorContentOffset,
} from "../src/v4/timelineToggleAnchor.js";

// 折叠组交互锚点：点击展开/收起时保持被点元素不动。测试锁住几条边界——
// 亚像素差异不写 scrollTop；锚点优先级高于「跟随中贴底」；scroll 事件补偿只认
// 非用户来源（焦点 scroll-into-view、virtualizer 晚到修正）；内容变化补偿走内容
// 坐标，不撤销用户自己的滚动；用户主动滚动立即让位，锚点结束。

test("timelineToggleAnchorAdjustment 对亚像素差异返回 0", () => {
  assert.equal(timelineToggleAnchorAdjustment(120, 120), 0);
  assert.equal(timelineToggleAnchorAdjustment(120, 120.4), 0);
  assert.equal(timelineToggleAnchorAdjustment(120, 119.6), 0);
});

test("timelineToggleAnchorAdjustment 返回可抵消偏移变化的 scrollTop 修正量", () => {
  // 内容撑高后贴底把锚点顶上去 64px：偏移变小，需要把 scrollTop 减回去。
  assert.equal(timelineToggleAnchorAdjustment(120, 56), -64);
  assert.equal(timelineToggleAnchorAdjustment(56, 120), 64);
});

test("锚点生效期间即使跟随中也不贴底", () => {
  assert.equal(
    resolveTimelineContentAnchorAction({
      toggleAnchorActive: true,
      following: true,
      contentWidthChanging: false,
    }),
    "hold",
  );
});

test("无锚点时沿用底部锚定裁决", () => {
  assert.equal(
    resolveTimelineContentAnchorAction({
      toggleAnchorActive: false,
      following: true,
      contentWidthChanging: false,
    }),
    "stickToBottom",
  );
  assert.equal(
    resolveTimelineContentAnchorAction({
      toggleAnchorActive: false,
      following: true,
      contentWidthChanging: true,
    }),
    "hold",
  );
  assert.equal(
    resolveTimelineContentAnchorAction({
      toggleAnchorActive: false,
      following: false,
      contentWidthChanging: false,
    }),
    "hold",
  );
});

test("折叠锚点窗口内抑制一切贴底入口", () => {
  assert.equal(shouldSuppressTimelineScrollToBottom(true), true);
  assert.equal(shouldSuppressTimelineScrollToBottom(false), false);
});

test("scroll 事件补偿只在非用户来源时写回锚点", () => {
  const base = {
    toggleAnchorActive: true,
    pointerScrollInteractionActive: false,
  };
  assert.equal(
    shouldCompensateTimelineToggleAnchorOnScroll({ ...base, userScrollIntent: "none" }),
    true,
  );
  // 用户滚轮/拖拽离开或靠近：立即让位，不写回。
  assert.equal(
    shouldCompensateTimelineToggleAnchorOnScroll({ ...base, userScrollIntent: "awayFromBottom" }),
    false,
  );
  assert.equal(
    shouldCompensateTimelineToggleAnchorOnScroll({ ...base, userScrollIntent: "towardBottom" }),
    false,
  );
  // 指针正在滚动条/触摸上：属于用户交互，不写回。
  assert.equal(
    shouldCompensateTimelineToggleAnchorOnScroll({
      ...base,
      userScrollIntent: "none",
      pointerScrollInteractionActive: true,
    }),
    false,
  );
  // 无锚点：不参与。
  assert.equal(
    shouldCompensateTimelineToggleAnchorOnScroll({
      toggleAnchorActive: false,
      userScrollIntent: "none",
      pointerScrollInteractionActive: false,
    }),
    false,
  );
});

test("选择器同时覆盖 Radix 触发器与历史行按钮", () => {
  assert.match(TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR, /data-slot='collapsible-trigger'/);
  assert.match(TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR, /chat-assistant-history-trigger/);
});

test("extendedTimelineToggleAnchorDelayMs 按基础窗口续期", () => {
  assert.equal(
    extendedTimelineToggleAnchorDelayMs({ startedAt: 1000, now: 1300 }),
    TIMELINE_TOGGLE_ANCHOR_WINDOW_MS,
  );
});

test("extendedTimelineToggleAnchorDelayMs 续期不超过自点击起的总窗口上限", () => {
  const delay = extendedTimelineToggleAnchorDelayMs({
    startedAt: 1000,
    now: 1000 + TIMELINE_TOGGLE_ANCHOR_MAX_WINDOW_MS - 100,
  });
  assert.equal(delay, 100);
  // 到达上限：不再续期。
  assert.equal(
    extendedTimelineToggleAnchorDelayMs({
      startedAt: 1000,
      now: 1000 + TIMELINE_TOGGLE_ANCHOR_MAX_WINDOW_MS,
    }),
    null,
  );
  assert.equal(
    extendedTimelineToggleAnchorDelayMs({
      startedAt: 1000,
      now: 1000 + TIMELINE_TOGGLE_ANCHOR_MAX_WINDOW_MS + 500,
    }),
    null,
  );
});

test("isTimelineToggleAnchorDetached 识别已脱离文档流的锚点元素", () => {
  // 重渲染卸载后 getBoundingClientRect 全 0，按偏移差补偿会算出垃圾修正量。
  assert.equal(isTimelineToggleAnchorDetached({ width: 0, height: 0 }), true);
  assert.equal(isTimelineToggleAnchorDetached({ width: 320, height: 24 }), false);
});

test("内容坐标等于视口偏移加 scrollTop，把用户滚动量排除在外", () => {
  assert.equal(timelineToggleAnchorContentOffset({ viewportOffset: 120, scrollTop: 0 }), 120);
  // 用户向下滚 250px：视口偏移同步减少 250，内容坐标保持不变。
  assert.equal(timelineToggleAnchorContentOffset({ viewportOffset: -130, scrollTop: 250 }), 120);
});

test("内容变化补偿不撤销用户自己的滚动", () => {
  // 复现现场：用户下滚 250px 后内容坐标没变，补偿量必须是 0，
  // 否则下一次内容变化就会把用户拽回点击时的位置（滚到底又被弹回的循环）。
  assert.equal(timelineToggleAnchorContentAdjustment(120, 120), 0);
  // 内容在锚点上方长高 100px：内容坐标 +100，scrollTop 跟着 +100 才不挪动被点的那行。
  assert.equal(timelineToggleAnchorContentAdjustment(120, 220), 100);
  // 亚像素差异不写 scrollTop。
  assert.equal(timelineToggleAnchorContentAdjustment(120, 120.4), 0);
  assert.equal(timelineToggleAnchorContentAdjustment(120, 119.6), 0);
});

test("用户主动滚动立即释放折叠锚点，向上向下都让位", () => {
  const base = {
    toggleAnchorActive: true,
    pointerScrollInteractionActive: false,
    userScrollObservedAt: 2000,
    anchorStartedAt: 1000,
  };
  assert.equal(
    shouldReleaseToggleAnchorOnUserScroll({ ...base, userScrollIntent: "awayFromBottom" }),
    true,
  );
  assert.equal(
    shouldReleaseToggleAnchorOnUserScroll({ ...base, userScrollIntent: "towardBottom" }),
    true,
  );
  // 方向未知（滚动条按下）与无滚动意图：不释放。
  assert.equal(
    shouldReleaseToggleAnchorOnUserScroll({ ...base, userScrollIntent: "unknown" }),
    false,
  );
  assert.equal(shouldReleaseToggleAnchorOnUserScroll({ ...base, userScrollIntent: "none" }), false);
  // 指针按在屏幕或滚动条上：属于持续交互，不在滚动过程中打断。
  assert.equal(
    shouldReleaseToggleAnchorOnUserScroll({
      ...base,
      userScrollIntent: "towardBottom",
      pointerScrollInteractionActive: true,
    }),
    false,
  );
  // 锚点登记之前残留的滚动意图不废掉刚建立的锚点。
  assert.equal(
    shouldReleaseToggleAnchorOnUserScroll({
      ...base,
      userScrollIntent: "towardBottom",
      userScrollObservedAt: 500,
      anchorStartedAt: 1000,
    }),
    false,
  );
  // 没有锚点：不参与。
  assert.equal(
    shouldReleaseToggleAnchorOnUserScroll({
      ...base,
      toggleAnchorActive: false,
      userScrollIntent: "towardBottom",
    }),
    false,
  );
});
