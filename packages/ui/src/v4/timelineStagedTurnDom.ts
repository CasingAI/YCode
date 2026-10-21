// 暗处节点不是定位落点。
//
// 时间线有两处「暗处」：首绘 staging 区（窗口整轮先在这里排版、量高、补齐够一屏）
// 与前插块的 staged 容器（补页内容先在这里暗处合练，提交时翻转进流）。两处都以
// 负偏移渲染在滚动区之外：量得到、看不见。
//
// 查找高亮与目录跳转都按 rowId 找 DOM。取到暗处副本，高亮会落在看不见的节点上，
// 跳转会拿屏幕外的坐标去算落点——用户看到的是「高亮不见了」或「莫名其妙跳到顶」。
// 暗处副本只参与测量，不参与定位。

const HIDDEN_TIMELINE_CONTAINER_SELECTORS = [
  // 首绘 staging 区。
  "[data-v4-timeline-first-paint-staging]",
  // 前插块的 staged 容器（每轮一个 wrapper）。
  "[data-staged-turn]",
] as const;

/** 元素是否落在时间线的暗处容器内。 */
export function isHiddenTimelineTurnNode(element: Element): boolean {
  return HIDDEN_TIMELINE_CONTAINER_SELECTORS.some((selector) => element.closest(selector) !== null);
}

/**
 * 找可见的行锚点。
 *
 * 同一 rowId 可能同时有一份可见副本与一份暗处副本（前插缝合：边界轮在窗口里的
 * 后半截既在暗处合练，也在虚拟列表里可见）。可见的那份才是落点。
 */
export function findMountedTimelineRowElement(
  root: HTMLElement,
  rowId: number,
): HTMLElement | null {
  for (const candidate of root.querySelectorAll<HTMLElement>(`[data-row-id="${rowId}"]`)) {
    if (isHiddenTimelineTurnNode(candidate)) continue;
    return candidate;
  }
  return null;
}
