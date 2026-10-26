// 分节阅读的纯交互/几何判定。渲染组件只负责收集 DOM 事实，规则放在这里便于隔离测试。
export const ASSISTANT_SECTION_DRAG_THRESHOLD_PX = 6;

export interface AssistantSectionPointerPosition {
  x: number;
  y: number;
}

/** 指针从按下位置移动超过阈值即视为拖选/滑动，不再把随后的 click 当作翻页。 */
export function hasExceededAssistantSectionDragThreshold(
  start: AssistantSectionPointerPosition | null,
  current: AssistantSectionPointerPosition,
  threshold = ASSISTANT_SECTION_DRAG_THRESHOLD_PX,
): boolean {
  if (!start) return false;
  const deltaX = current.x - start.x;
  const deltaY = current.y - start.y;
  return deltaX * deltaX + deltaY * deltaY > threshold * threshold;
}

/**
 * 只有卡片背景/留白本身、未拖选、无文本选区且不是双击后续时，点击才翻到下一节。
 * 正文文字、链接、代码、表单等目标天然不等于卡片本身，因此不会进入这里。
 * 选区还要看 pointerdown 起点：点击空白会先折叠旧选区，click 时只看当前值会误翻页。
 */
export function shouldAdvanceAssistantSectionFromClick(options: {
  targetIsCard: boolean;
  clickCount: number;
  selectionCollapsed: boolean;
  selectionCollapsedAtPointerDown: boolean;
  dragExceeded: boolean;
}): boolean {
  return (
    options.targetIsCard &&
    options.clickCount <= 1 &&
    options.selectionCollapsed &&
    options.selectionCollapsedAtPointerDown &&
    !options.dragExceeded
  );
}

export type AssistantSectionNavigationIntent = -1 | 1 | null;

/** 局部方向键/翻页键只接受卡片或头部焦点；正文控件与带修饰键的按键一律放行。 */
export function resolveAssistantSectionKeyboardIntent(options: {
  key: string;
  targetInsideContent: boolean;
  defaultPrevented?: boolean;
  hasModifier?: boolean;
}): AssistantSectionNavigationIntent {
  if (options.defaultPrevented || options.hasModifier || options.targetInsideContent) {
    return null;
  }
  switch (options.key) {
    case "ArrowLeft":
    case "PageUp":
      return -1;
    case "ArrowRight":
    case "PageDown":
      return 1;
    default:
      return null;
  }
}

/**
 * 优先使用真实阅读容器高度；拿不到或为 0 时回退视口高度。
 * 窄屏与桌面分别对应 40dvh/46dvh 的比例和上下限，保证随可用空间增长但不会占满整屏。
 */
export function resolveAssistantSectionMinHeight(options: {
  availableHeight?: number | null;
  viewportHeight: number;
  viewportWidth: number;
  /** 真实对话容器宽度；分栏窗口比视口更窄时也按窄屏处理。 */
  availableWidth?: number | null;
}): number {
  const narrow = (options.availableWidth ?? options.viewportWidth) < 640;
  const fallbackHeight = options.viewportHeight > 0 ? options.viewportHeight : 0;
  const available =
    options.availableHeight !== undefined &&
    options.availableHeight !== null &&
    options.availableHeight > 0
      ? options.availableHeight
      : fallbackHeight;
  const ratio = narrow ? 0.4 : 0.46;
  const minimum = narrow ? 160 : 220;
  const maximum = narrow ? 320 : 480;
  return Math.round(Math.min(maximum, Math.max(minimum, available * ratio)));
}
