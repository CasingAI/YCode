export function isCoarseTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function shouldRestoreChatInputFocusAfterPickerClose({
  isCoarseTouchDevice: coarseTouch,
}: {
  isCoarseTouchDevice: boolean;
}): boolean {
  // 手机触控设备关闭工具栏弹层后，如果继续把焦点送回 contenteditable，
  // 系统软键盘会再次弹出并遮挡远控界面；桌面端仍保留关闭后继续输入的键盘流。
  return !coarseTouch;
}

/**
 * 点开时间线折叠块后，是否需要显式把焦点让出 composer。
 *
 * 触屏上 `mousedown` 的 preventDefault 未必能阻止焦点转移，且各触发器 DOM 形态不一
 * （button / div[role=button]），焦点落点不可控。composer 若仍持有 DOM 焦点，展开
 * 引起的内容高度变化与 scrollTop 补偿会把 contenteditable 重新滚入视口，移动端 OS
 * 随之唤起软键盘遮挡刚展开的内容。因此移动端显式 blur，桌面端保持触发器自然接管焦点。
 */
export function shouldBlurComposerOnCollapsibleToggle({
  isCoarseTouchDevice: coarseTouch,
}: {
  isCoarseTouchDevice: boolean;
}): boolean {
  return coarseTouch;
}
