import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveConversationStatusPanelPopoverSide,
  resolveConversationTodoGroupPresentation,
} from "../src/v4/conversationLayout.js";

// 窄视口下面板是覆盖层，占掉 `100vw - 336px`，左侧只剩一条点不到的窄缝。
// 若仍往左弹，浮层会被面板自己盖住，屏幕左缘只剩一条残片，因此必须向下弹。
test("窄视口下面板内浮层向下弹", () => {
  assert.equal(resolveConversationStatusPanelPopoverSide({ isNarrowViewport: true }), "bottom");
});

// 宽视口保持向左：面板右侧锚定，左侧是会话列的富余空间，桌面观感不能变。
test("宽视口下面板内浮层仍向左弹", () => {
  assert.equal(resolveConversationStatusPanelPopoverSide({ isNarrowViewport: false }), "left");
});

// 窄视口没有悬浮落点：面板贴着视口上沿，浮层向下放不下就向上翻转、糊在屏幕顶端
// 盖住应用头部。折叠分组必须就地展开，而不是换个方向继续当浮层。
test("窄视口下折叠 Todo 分组就地展开", () => {
  assert.equal(resolveConversationTodoGroupPresentation({ isNarrowViewport: true }), "inline");
});

// 宽视口保留桌面既有的 hover 预览浮层。
test("宽视口下折叠 Todo 分组仍用悬浮预览", () => {
  assert.equal(resolveConversationTodoGroupPresentation({ isNarrowViewport: false }), "floating");
});
