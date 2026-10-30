export const FILES_EDITOR_TAB_CROWD_THRESHOLD = 96;

/**
 * 标签条紧凑模式阈值：按组容器宽度判断，分屏后的窄组同样生效。
 * 低于该宽度时源码/预览改为图标，并隐藏分屏按钮，把宽度留给标签。
 */
export const FILES_EDITOR_TAB_COMPACT_MAX_WIDTH = 420;

/** 标签最小可读宽度；放不下时标签区横向滚动，而不是把标题压成 0。 */
export const FILES_EDITOR_TAB_MIN_WIDTH = 96;

/** Tabs enter crowded mode only when multiple tabs cannot average the target width. */
export function shouldCrowdFilesEditorTabs(width: number, count: number): boolean {
  return (
    Number.isFinite(width) &&
    width >= 0 &&
    Number.isInteger(count) &&
    count > 1 &&
    width / count < FILES_EDITOR_TAB_CROWD_THRESHOLD
  );
}

/** 紧凑模式只看组容器宽度，不读取 viewport；宽 0 的首次测量不算窄。 */
export function isFilesEditorTabBarCompact(width: number): boolean {
  return Number.isFinite(width) && width > 0 && width < FILES_EDITOR_TAB_COMPACT_MAX_WIDTH;
}

/** In crowded mode, the selected or hovered tab gets extra room without changing tab order. */
export function filesEditorTabFlex(crowded: boolean, selected: boolean, hovered: boolean): string {
  return crowded && (selected || hovered) ? "2.4 1 0%" : "1 1 0%";
}

/**
 * 计算让活动标签完整落在标签区可视范围所需的 scrollLeft。
 *
 * 标签区可横向滚动后，程序激活视口外的标签（文件树、快捷键、恢复会话）不会自动滚动；
 * 这里只做几何校正，由调用方写回 scrollLeft，避免 scrollIntoView 连带滚动外层页面。
 * `tabOffsetLeft` 是标签相对可视区左边缘的偏移（已包含当前滚动）。
 */
export function resolveFilesEditorTabScrollLeft({
  scrollLeft,
  viewportWidth,
  scrollWidth,
  tabOffsetLeft,
  tabWidth,
}: {
  scrollLeft: number;
  viewportWidth: number;
  scrollWidth: number;
  tabOffsetLeft: number;
  tabWidth: number;
}): number {
  if (
    [scrollLeft, viewportWidth, scrollWidth, tabOffsetLeft, tabWidth].some(
      (value) => !Number.isFinite(value),
    ) ||
    viewportWidth <= 0 ||
    tabWidth <= 0
  ) {
    return scrollLeft;
  }
  const maxScrollLeft = Math.max(0, scrollWidth - viewportWidth);
  const tabContentLeft = scrollLeft + tabOffsetLeft;
  let targetScrollLeft = scrollLeft;
  if (tabWidth >= viewportWidth || tabContentLeft < scrollLeft) {
    targetScrollLeft = tabContentLeft;
  } else if (tabContentLeft + tabWidth > scrollLeft + viewportWidth) {
    targetScrollLeft = tabContentLeft + tabWidth - viewportWidth;
  }
  return Math.min(Math.max(0, targetScrollLeft), maxScrollLeft);
}
