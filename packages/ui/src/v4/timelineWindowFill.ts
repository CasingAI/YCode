// 静默补齐的停止条件（纯函数，无 React / DOM 依赖）。
//
// 产品口径（docs/specs/conversation-timeline-turn-window-fill.md）：
// 一次加载在挂进可见区之前，折叠后的内容至少铺满一屏；不够就在同一次补齐里按整轮
// 继续往上加。停止条件只有两个——铺满一屏，或没有更早历史（撞单帧体积上限的轮由
// CLI 侧处理，客户端不拆轮）。
//
// 为什么单独成模块：判定要同时看 staged 实测高度、视口高度、事务游标与取数在途
// 状态，混进组件里会退化成「看到 false 就取下一页」的散落判断，而空页与在途
// 请求的自旋恰恰从这里开始。

export interface TimelineWindowFillInput {
  /** staged 暗处实测的折叠高度（px）。0 = 还没排版完。 */
  stagedHeightPx: number;
  /** 滚动视口高度（px）。 */
  viewportHeightPx: number;
  /** 事务最后一页是否报告还有更早历史（无事务时回落到窗口还有更早行）。 */
  hasMoreOlder: boolean;
  /**
   * 本次更早取数是否在途。
   *
   * 必须是 store 的「请求在途」而不是「补齐事务未完结」：事务缓冲从第一页落地起就
   * 一直开着，拿它当单飞信号，补齐循环在第一页之后就再也不会发出第二次请求。
   */
  fetchingOlder: boolean;
}

/**
 * 停止条件：折叠高度已铺满一屏，或没有更早历史。
 *
 * 「铺满」用 `>=` 而不是 `>`：视口高 800、折叠内容恰好 800 时它就是够的，
 * 再去多取一页只会让首绘更慢。
 */
export function isTimelineWindowFillComplete(input: TimelineWindowFillInput): boolean {
  if (!input.hasMoreOlder) return true;
  if (input.stagedHeightPx <= 0 || input.viewportHeightPx <= 0) return false;
  return input.stagedHeightPx >= input.viewportHeightPx;
}

/**
 * 是否需要继续取下一页整轮。
 *
 * 与 `isTimelineWindowFillComplete` 互为否定，另外挡住在途请求：那种情况下重复调用
 * store 是 no-op，但会把补齐判定排成一串空转。
 */
export function shouldContinueTimelineWindowFill(input: TimelineWindowFillInput): boolean {
  if (isTimelineWindowFillComplete(input)) return false;
  // 高度未知（staged 还没排版出高度、视口还没量到）时不下结论：此刻取页只会让
  // 「排版 → 取页 → 再排版」在首帧前多跑一轮，且高度回来时可能已经取过头。
  if (input.stagedHeightPx <= 0 || input.viewportHeightPx <= 0) return false;
  if (input.fetchingOlder) return false;
  return true;
}

/**
 * 顶部加载提示的透明度开关：补齐进行中且超过 `delayMs` 才显示。
 *
 * 快链路（本地 stdio 常见几十毫秒）全程透明——块只占位不显形；慢网络才有文字。
 */
export function shouldShowTimelineLoadingHint(input: {
  pending: boolean;
  elapsedMs: number;
  delayMs: number;
}): boolean {
  return input.pending && input.elapsedMs >= input.delayMs;
}
