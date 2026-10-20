// 窄视口下「大幅右滑打开侧栏」手势的纯判定。
//
// 这里只做计算，不读 DOM：外壳把结果翻译成事件订阅，node --test 则可以直接覆盖
// 这些分支。DOM 侧的事件接线在 useWorkspaceSidebarSwipe.ts，
// 产品规则见 docs/specs/workspace-shell-swipe-gesture.md。
//
// 不变式：手势不拦截浏览器行为。全程不调用 preventDefault，判定与让位都是
// 「观察」——一旦判定为竖向滚动或被内层滚动容器接管，就整个作废，绝不与
// 原生滚动竞争。

/**
 * 方向锁定所需的最小位移（px）。
 * 低于它既不算横向也不算纵向，手势继续观察：手指刚落下时往往有几像素的
 * 抖动，若在第一帧就判方向，抖一下就会被误判成一次右滑。
 */
export const SWIPE_DIRECTION_LOCK_DISTANCE_PX = 8;

/**
 * 触发打开的最小位移下限（px）。
 * 固定下限保证小屏上阈值不会被屏宽压到几十像素——那会让「随手一划」误触发。
 */
export const SWIPE_OPEN_MIN_DISTANCE_PX = 96;

/**
 * 触发打开的最小位移占视口宽度的比例。
 * 比例项保证大屏上仍然需要一次明显的大幅滑动，而不是轻微的手腕动作。
 */
export const SWIPE_OPEN_MIN_VIEWPORT_RATIO = 0.25;

/** 手势方向。`undecided` 表示还没锁定，位移还不足以判方向。 */
export type SwipeAxis = "undecided" | "horizontal" | "vertical";

/**
 * 方向仲裁。横向与纵向的比较只看位移量，不看方向符号——符号留给调用方
 * 判断「是不是往右」：向左的横滑同样锁定为 horizontal，只是随后会被作废。
 */
export function resolveSwipeAxis(params: {
  deltaX: number;
  deltaY: number;
}): SwipeAxis {
  const { deltaX, deltaY } = params;
  if (
    Math.abs(deltaX) < SWIPE_DIRECTION_LOCK_DISTANCE_PX &&
    Math.abs(deltaY) < SWIPE_DIRECTION_LOCK_DISTANCE_PX
  ) {
    return "undecided";
  }
  return Math.abs(deltaX) >= Math.abs(deltaY) ? "horizontal" : "vertical";
}

/**
 * 触发打开所需的净右移量阈值。
 */
export function resolveSwipeOpenThresholdPx(params: {
  viewportWidthPx: number;
}): number {
  return Math.max(
    SWIPE_OPEN_MIN_DISTANCE_PX,
    Math.round(params.viewportWidthPx * SWIPE_OPEN_MIN_VIEWPORT_RATIO),
  );
}

/**
 * 是否达到打开阈值。
 *
 * 判的是净位移而不是路径长度：滑出去再滑回来不算数，否则一次来回试探
 * 就能把侧栏拽开。向左一律不触发——本条规范只做打开方向。
 */
export function shouldOpenSidebarFromSwipe(params: {
  deltaX: number;
  viewportWidthPx: number;
  thresholdPx?: number;
}): boolean {
  if (params.deltaX <= 0) {
    return false;
  }
  const thresholdPx =
    params.thresholdPx ??
    resolveSwipeOpenThresholdPx({ viewportWidthPx: params.viewportWidthPx });
  return params.deltaX >= thresholdPx;
}

/**
 * 一个元素是否算「可横向滚动的容器」。
 *
 * 判据是两条同时成立：overflow-x 允许滚动，且内容确实超宽。
 * 只看 overflow-x 是不够的——代码块的滚动容器在用户开启「自动换行」后
 * 就不再超宽，此时滑动理应打开侧栏，而不是被一条「长得像滚动容器」的
 * 规则一直排除掉。
 */
export function isHorizontallyScrollableContainer(params: {
  scrollWidth: number;
  clientWidth: number;
  overflowX: string;
}): boolean {
  if (params.overflowX !== "auto" && params.overflowX !== "scroll") {
    return false;
  }
  return params.scrollWidth - params.clientWidth > 1;
}

/**
 * 一次触摸序列的手势状态。
 *
 * 抽成独立状态机是为了让它能被 node --test 直接覆盖：接线部分在
 * useWorkspaceSidebarSwipe.ts 的 effect 闭包里，没有 DOM 就跑不起来。
 */
export interface SwipeGestureState {
  /** 方向是否已经锁定。 */
  axis: SwipeAxis;
  /** 已判定不该管（竖向滚动 / 向左 / 被内层滚动容器接管）。 */
  abandoned: boolean;
  /** 位移已越过阈值，等抬手时提交。 */
  pendingOpen: boolean;
}

export function createSwipeGestureState(): SwipeGestureState {
  return { axis: "undecided", abandoned: false, pendingOpen: false };
}

/**
 * 推进一次移动，返回新的状态。
 *
 * 状态机的三个出口：
 * - 锁定为纵向 → 整个序列作废，交还给浏览器的原生滚动；
 * - 锁定为向左的横向 → 作废，本次只做打开方向；
 * - 越过阈值 → 标记 pendingOpen 并作废后续移动，等抬手时再真正打开。
 *
 * 「越过阈值也不立刻打开」是刻意的：此刻抽屉还是收起态，遮罩是惰性的；
 * 若在此刻展开，抽屉的遮罩会落到用户手指底下，抬手时浏览器合成的 click
 * 可能落在遮罩上，把刚打开的抽屉又关掉。
 */
export function advanceSwipeGesture(params: {
  state: SwipeGestureState;
  deltaX: number;
  deltaY: number;
  viewportWidthPx: number;
}): SwipeGestureState {
  const { state } = params;
  if (state.abandoned) {
    return state;
  }

  let axis = state.axis;
  if (axis === "undecided") {
    axis = resolveSwipeAxis({ deltaX: params.deltaX, deltaY: params.deltaY });
    if (axis === "undecided") {
      return state;
    }
    if (axis !== "horizontal" || params.deltaX <= 0) {
      return { ...state, axis, abandoned: true };
    }
  }

  if (
    !shouldOpenSidebarFromSwipe({
      deltaX: params.deltaX,
      viewportWidthPx: params.viewportWidthPx,
    })
  ) {
    return { ...state, axis };
  }

  return { ...state, axis, pendingOpen: true, abandoned: true };
}
