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

export interface TimelinePrependFillInput {
  /** staged 暗处实测的折叠高度（px）。0 = 还没排版完。 */
  stagedHeightPx: number;
  /** 滚动视口高度（px）。 */
  viewportHeightPx: number;
  /** 事务最后一页是否报告还有更早历史（无事务时回落到窗口还有更早行）。 */
  hasMoreOlder: boolean;
  /** 本次更早取数是否在途（store 的 fetchingOlder，语义同上）。 */
  fetchingOlder: boolean;
  /**
   * 缓冲最老行的 `ConversationRowKind`；缓冲为空时 null。
   *
   * 整轮取窗后每页要么以轮头开始，要么是被单帧上限拆开的巨轮中段——
   * 用 kind 而不是 turnId 对比来判定「整轮到齐」：拆轮页取到轮头那一页，
   * 最老行与窗口首行仍同轮（turnId 相同），按轮对比会误判未到齐而多取一页。
   */
  bufferOldestRowKind: string | null;
}

/**
 * 上滚补页的「整轮到齐」（turn-window-fill 规则 11a）：缓冲最老行是 `turnHeader`，
 * 或已没有更早历史。
 *
 * 缓冲为空时视为到齐——此刻没有边界轮可言，守门交给高度条件（未排版即 0，
 * `isTimelinePrependFillCommitReady` 自然不放行）。
 */
export function isTimelinePrependFillTurnAligned(
  input: Pick<TimelinePrependFillInput, "bufferOldestRowKind" | "hasMoreOlder">,
): boolean {
  if (!input.hasMoreOlder) return true;
  return input.bufferOldestRowKind === null || input.bufferOldestRowKind === "turnHeader";
}

/**
 * 上滚补页的提交就绪：铺满一屏 **且** 整轮到齐，或没有更早历史。
 *
 * 这是前插闸门放行条件的填充半边（位置半边仍是「已停在顶部」）：不满足时闸门
 * 不排程提交，由 Timeline 的填充循环继续静默取页——用户不允许看见同一轮的
 * 「工具 N 次」计数分批上涨。
 */
export function isTimelinePrependFillCommitReady(input: TimelinePrependFillInput): boolean {
  if (!input.hasMoreOlder) return true;
  if (input.stagedHeightPx <= 0 || input.viewportHeightPx <= 0) return false;
  if (input.stagedHeightPx < input.viewportHeightPx) return false;
  return isTimelinePrependFillTurnAligned(input);
}

/**
 * 填充循环是否继续取下一页：提交未就绪、高度已知、请求不在途。
 *
 * 高度未知时不下结论（同 `shouldContinueTimelineWindowFill`）：等排版回调，
 * 此刻取页只会让「排版 → 取页 → 再排版」多跑一轮。第一页由既有预取路径
 * （接近顶部两视口）发起，本循环只负责后续页的静默累积。
 */
export function shouldContinueTimelinePrependFill(input: TimelinePrependFillInput): boolean {
  if (isTimelinePrependFillCommitReady(input)) return false;
  if (input.stagedHeightPx <= 0 || input.viewportHeightPx <= 0) return false;
  if (input.fetchingOlder) return false;
  return true;
}
