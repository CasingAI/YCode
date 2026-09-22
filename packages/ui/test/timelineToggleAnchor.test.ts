import assert from "node:assert/strict";
import test from "node:test";
import {
  TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR,
  resolveTimelineContentAnchorAction,
  shouldCompensateTimelineToggleAnchorOnScroll,
  shouldSuppressTimelineScrollToBottom,
  timelineToggleAnchorAdjustment,
} from "../src/v4/timelineToggleAnchor.js";

// 折叠组交互锚点：点击展开/收起时保持被点元素不动。测试锁住几条边界——
// 亚像素差异不写 scrollTop；锚点优先级高于「跟随中贴底」；scroll 事件补偿只认
// 非用户来源（焦点 scroll-into-view、virtualizer 晚到修正），用户滚动立即让位。

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
