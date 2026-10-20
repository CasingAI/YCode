import type { MouseEvent, PointerEvent } from "react";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import { isCoarseTouchDevice, shouldBlurComposerOnCollapsibleToggle } from "@/lib/pickerFocus.js";

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

/**
 * 移动端点开折叠块时，把焦点从 composer 输入框上让开。
 *
 * 折叠触发器的 `mousedown` preventDefault 会阻止焦点转移（见上），于是一次点击既没把
 * 焦点移到触发器、也没让输入框失焦，焦点被钉在 contenteditable 上；展开引起的内容高度
 * 变化与 scrollTop 补偿又把仍带焦点的输入框滚回视口，移动端随之唤起软键盘遮挡刚展开
 * 的内容。桌面端保留触发器自然接管焦点的行为，不做干预。
 *
 * 只在焦点确实落在 composer 输入框上时才 blur，避免误伤其它输入框。
 */
export function blurComposerInputOnMobileToggle(): void {
  if (typeof document === "undefined") return;
  if (!shouldBlurComposerOnCollapsibleToggle({ isCoarseTouchDevice: isCoarseTouchDevice() })) {
    return;
  }
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (!active.closest(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)) return;
  active.blur();
}
