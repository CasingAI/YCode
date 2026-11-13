export const SIDE_PANE_DEFAULT_EXPANDED_SIZE = "45%";
export const SIDE_PANE_DEFAULT_EXPANDED_RATIO = 0.45;

const SIDE_PANE_TAB_MIN_WIDTH_PX = 60;
const SIDE_PANE_TAB_GAP_PX = 4;
const SIDE_PANE_TAB_OVERFLOW_TOLERANCE_PX = 1;

export function resolveSidePaneTabsOverflow({
  addButtonInside,
  addButtonWidth,
  tabCount,
  viewportWidth,
}: {
  addButtonInside: boolean;
  addButtonWidth: number;
  tabCount: number;
  viewportWidth: number;
}): boolean {
  const tabsWidth =
    tabCount * SIDE_PANE_TAB_MIN_WIDTH_PX + Math.max(0, tabCount - 1) * SIDE_PANE_TAB_GAP_PX;
  const addButtonGap = tabCount > 0 ? SIDE_PANE_TAB_GAP_PX : 0;
  const viewportWidthWithAddButtonInside = viewportWidth + (addButtonInside ? 0 : addButtonWidth);
  const contentWidthWithAddButtonInside = tabsWidth + addButtonGap + addButtonWidth;

  return (
    contentWidthWithAddButtonInside >
    viewportWidthWithAddButtonInside + SIDE_PANE_TAB_OVERFLOW_TOLERANCE_PX
  );
}

export type SidePaneTabsMaskEdges = {
  left: boolean;
  right: boolean;
};

export const EMPTY_SIDE_PANE_TABS_MASK_EDGES: SidePaneTabsMaskEdges = {
  left: false,
  right: false,
};

/**
 * 由 overflow 事实与当前 scrollLeft 派生两端 mask。
 *
 * 只接收位置和已测得的 maxScrollLeft，不接触 DOM：普通滚动路径因此可以复用几何缓存，
 * 不必重复读取 scrollWidth/clientWidth。1px 容差与滚动判定保持一致，避免贴边时两端同时亮。
 */
export function resolveSidePaneTabsMaskEdges({
  isOverflowing,
  scrollLeft,
  maxScrollLeft,
}: {
  isOverflowing: boolean;
  scrollLeft: number;
  maxScrollLeft: number;
}): SidePaneTabsMaskEdges {
  return {
    left: isOverflowing && scrollLeft > 1,
    right: isOverflowing && scrollLeft < maxScrollLeft - 1,
  };
}
