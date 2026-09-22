import type { MouseEvent, PointerEvent } from "react";

/**
 * 时间线内折叠触发器的 DOM 交互辅助。
 *
 * 点击 button/div 获得焦点时，浏览器会把焦点元素滚到滚动容器可视区域顶边；桌面顶栏
 * 画在会话上方，不参与 scroll-margin，于是展开内容最上面会被 Header 挡住。
 * 用 mousedown preventDefault 阻止鼠标点击抢焦点（键盘 Tab 仍可聚焦）。
 */

/** 与 DesktopTopOverlay h-14 对齐，供 scroll-margin-top 预留顶栏安全区。 */
export const TIMELINE_COLLAPSIBLE_SCROLL_MARGIN_TOP_CLASS = "scroll-mt-14";

/** 鼠标主键按下：阻止随后 focus 触发的 scroll-into-view。 */
export function preventTimelineCollapsibleFocusScroll(
  event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>,
): void {
  if ("button" in event && event.button !== 0) {
    return;
  }
  event.preventDefault();
}
