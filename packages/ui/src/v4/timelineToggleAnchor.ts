// 折叠组交互锚点（纯逻辑，无 DOM/React 依赖）。
//
// 背景：时间线按「内容高度变化」裁决滚动——跟随中贴底。但用户点击某个折叠组触发器
// 展开/收起时，他要看的是**自己点的那一块**，不是内容的末尾：折叠动画的 300ms 里逐帧
// 贴底会把刚点的行连续顶到视口上方（桌面端顶部还有 h-14 的悬浮 Header，前一两行直接
// 被盖住）。这类交互的语义是保持锚点，而不是重新定位。
//
// 判定与补偿量放在这里；记录锚点、读写 scrollTop 的接线留在 ConversationTimeline。

import { anchorActionAfterContentChange } from "./timelineScrollAnchor.js";

/**
 * 折叠触发器选择器。
 * - ui 外壳 `CollapsibleTrigger` 的 data-slot；
 * - 「已工作」历史行按钮（test id 前缀，防止 asChild 合槽失败时漏登记）。
 */
export const TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR =
  "[data-slot='collapsible-trigger'], [data-testid^='chat-assistant-history-trigger']";

/** 折叠锚点作用窗口：动画 300ms + 虚拟列表收尾测高 + 焦点滚动补偿余量。 */
export const TIMELINE_TOGGLE_ANCHOR_WINDOW_MS = 650;

/** 贴底/程序化滚动在折叠锚点窗口内应让位给「点哪留哪」。 */
export function shouldSuppressTimelineScrollToBottom(toggleAnchorActive: boolean): boolean {
  return toggleAnchorActive;
}

/**
 * 折叠锚点窗口内，非用户滚轮/拖拽导致的 scroll 事件是否应写回锚点。
 * 典型来源：焦点 scroll-into-view、virtualizer 晚到的 scrollTop 修正。
 */
export function shouldCompensateTimelineToggleAnchorOnScroll(input: {
  toggleAnchorActive: boolean;
  userScrollIntent: "none" | "awayFromBottom" | "towardBottom" | "unknown";
  pointerScrollInteractionActive: boolean;
}): boolean {
  if (!input.toggleAnchorActive) return false;
  if (input.pointerScrollInteractionActive) return false;
  if (input.userScrollIntent === "awayFromBottom") return false;
  return input.userScrollIntent === "none";
}

/** 亚像素差异不写 scrollTop，避免动画期间每帧无意义地改写滚动位置。 */
const TOGGLE_ANCHOR_EPSILON_PX = 0.5;

/**
 * 钉住锚点元素所需的 scrollTop 修正量。
 *
 * 记录点与实测点都是「锚点元素相对滚动容器顶部的偏移」。元素在文档流里的位置没变，
 * 偏移变化只可能来自 scrollTop 变化，所以把差值加回 scrollTop 就能抵消它。
 */
export function timelineToggleAnchorAdjustment(
  recordedOffsetTop: number,
  currentOffsetTop: number,
): number {
  const delta = currentOffsetTop - recordedOffsetTop;
  return Math.abs(delta) < TOGGLE_ANCHOR_EPSILON_PX ? 0 : delta;
}

/**
 * 内容变化后的滚动动作：折叠锚点生效期间一律保持位置，其余情况沿用底部锚定裁决。
 * 锚点优先于 following——点击折叠组是「看我点的那块」，不是「跟着新内容走」。
 */
export function resolveTimelineContentAnchorAction(input: {
  toggleAnchorActive: boolean;
  following: boolean;
  contentWidthChanging: boolean;
}): "stickToBottom" | "hold" {
  if (input.toggleAnchorActive) return "hold";
  return anchorActionAfterContentChange(input.following, input.contentWidthChanging);
}
