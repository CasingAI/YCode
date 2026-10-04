// 前插提交闸门：判断「已到顶部」并把落窗口排到那一刻（纯逻辑，无 React / DOM 依赖）。
//
// 为什么不再等静止：原先用一段静默窗口躲开触摸惯性与到顶橡皮筋，但那只解决了
// 「用户还在动」。真正的难点是提交那一刻必须已经知道待插入内容有多高，否则 virtualizer
// 只能用估值渲染、渲染完再逐条修正，每次修正都要再补一次 scrollTop——同一个位移被
// 算多遍，列表就漂了。现在改成：内容先以 staged 块（负偏移隐藏、真实宽度）渲染在
// 块容器里，量过即装载；列表在整个 pending 窗口锁死不动。锁住之后惯性与橡皮筋都不
// 成立，等待时间不再是正确性的一部分。高度闸门在组件里是块级的（staged 节点挂载并
// 经过一次布局即就绪）——装载用的就是量过的那批节点，不存在「渲染完被修正」的第二遍。

/**
 * 判定「已到顶部」的 scrollTop 容差。取亚像素级：占位块在列表最顶端，scrollTop 归零
 * 才意味着它完整可见，也就是用户正在看它。留 0.5px 容忍浮点误差。
 */
export const PREPEND_COMMIT_TOP_EPSILON_PX = 0.5;

/** 滚动是否已到顶部。 */
export function isTimelineAtTop(scrollTop: number): boolean {
  return Number.isFinite(scrollTop) && scrollTop <= PREPEND_COMMIT_TOP_EPSILON_PX;
}

/**
 * pending 窗口内是否锁住滚动。
 *
 * 两个条件缺一不可，而且**位置条件必须在外面**：
 *
 * - `hasPendingOlder`：有缓冲才需要锁，锁是为了冻结这一页的落窗口过程。
 * - `reachedTop`：用户已经抵达顶部。
 *
 * 第二个条件不能省，也不能换成「取数已开始」。预取提前两个视口发出，若跟着取数上锁，
 * 用户会在离顶两屏处被冻住、再也上不去；闸门要求到顶，位置条件恒假，提交永不发生，
 * 锁也就永不释放——锁与顶部条件互相把对方锁死，列表在半路永久冻结。
 *
 * 「用户看到占位块」正是抵达顶部那一刻，所以锁的起点也正是那一刻。
 */
export function isTimelinePrependScrollLocked(
  hasPendingOlder: boolean,
  reachedTop: boolean,
): boolean {
  return hasPendingOlder && reachedTop;
}

/**
 * 顶部实心块（分享只读块 + 补页占位块 + 前插块容器）高度变化时，scrollTop 要跟着
 * 平移同样的距离。
 *
 * 为什么必须有：视觉位置 = inset + contentOffset - scrollTop。占位块出现在顶部会让
 * 下方内容整体被推下它的高度——正是本模块要消除的那类位移。平移 scrollTop 之后，
 * 占位块变成视口上方的一段可滚动空间。
 *
 * 同一个表达式也覆盖提交那一刻：inset 由 h 变 0、同时前插了 Δ 高度的真实内容，
 * 需要的写入是 `Δ + (0 - h)`，而现有 prepend 补偿只给得出 Δ。
 *
 * 这一次平移是安全的，因为 pending 窗口内列表被锁死，不存在与用户手势并发。
 */
export function timelineTopInsetAdjustment(previousPx: number, nextPx: number): number {
  return nextPx - previousPx;
}

/** 定时器由调用方注入，便于单测用假定时器推进。 */
export interface TimelinePrependCommitScheduler {
  /** 返回取消函数。 */
  schedule(callback: () => void, delayMs: number): () => void;
}

/**
 * 落窗口的结果。
 *
 * retry 让调用方区分两种「没并入」：游标失效说明这页取自已被改写的窗口，应按新
 * 游标重取；无可并入行说明这页本来就没有更早内容，重取只会自旋。合成一个
 * boolean 会让调用方在「丢弃后重取」和「空页别重试」之间二选一地错。
 */
export type PendingOlderCommitResult =
  | { committed: true }
  | { committed: false; retry: true }
  | { committed: false; retry: false };

/**
 * 把「落窗口」排程到「已停在顶部」的那一刻。
 *
 * 三条不变量：
 * - 不在顶部就不排程：用户停在半路时缓冲不落，也不空转计时器；
 * - 同一时刻只有一个待触发的 commit 回调，重排不叠加；
 * - 永远经 scheduler 排到下一个 task，不在调用方栈上直接跑：调用方可能是 React 的
 *   passive effect，而提交要用 flushSync，在那里调用会触发 React 的
 *   「flushSync was called from inside a lifecycle method」告警。
 */
export class TimelinePrependCommitGate {
  private lastScrollTopPx: number | null = null;
  private requestedCommit: (() => void) | null = null;
  private cancelTimer: (() => void) | null = null;

  constructor(private readonly scheduler: TimelinePrependCommitScheduler) {}

  /**
   * 每次 scroll 事件都要喂一次：记录位置。
   *
   * 位置只从 scroll 事件取，这是精确的——浏览器不可能在不发事件的情况下改变
   * scrollTop，所以「最后一次观察到的位置」就是真实位置。
   */
  noteScroll(scrollTopPx: number): void {
    this.lastScrollTopPx = scrollTopPx;
    this.rearm();
  }

  /**
   * 同步当前是否存在待提交内容。无内容时顺带取消排程。
   *
   * 位置只从 scroll 事件取的前提是「浏览器改变 scrollTop 必发事件」，在虚拟列表里
   * 不成立：折叠/展开与测高收缩会让 scrollHeight 剧变、浏览器自发 clamp scrollTop，
   * 这类变化要么没有事件，要么事件被 layout guard 归为 layout 而跳过账本。调用方
   * 在 effects 阶段读到的容器实时 scrollTop 就是布局终值（含这类 clamp），为有限
   * 数时覆盖账本、与布局对账一次；undefined 则沿用账本（未挂载时保持 null 兜底）。
   * 对账双向生效：账本残留非顶值 + 布局在顶 → 放行提交；账本在顶 + 布局离顶 → 不放行。
   */
  request(hasPending: boolean, commit: () => void, observedScrollTopPx?: number | null): void {
    if (
      observedScrollTopPx !== undefined &&
      observedScrollTopPx !== null &&
      Number.isFinite(observedScrollTopPx)
    ) {
      this.lastScrollTopPx = observedScrollTopPx;
    }
    this.requestedCommit = hasPending ? commit : null;
    this.rearm();
  }

  /** 会话切换或卸载时调用，避免旧排程落到新会话上。 */
  cancel(): void {
    this.requestedCommit = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private atTop(): boolean {
    // 从未滚过时无从判断位置，按在顶部处理：内容不足一屏的补页没有「继续上滑」这个
    // 动作，不该因此永远不提交。
    return this.lastScrollTopPx === null || isTimelineAtTop(this.lastScrollTopPx);
  }

  private rearm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.requestedCommit === null) return;
    if (!this.atTop()) return;
    this.cancelTimer = this.scheduler.schedule(() => {
      this.cancelTimer = null;
      const commit = this.requestedCommit;
      // 先摘掉再执行：提交会换 snapshot，进而让调用方同步跑一遍新的 request，
      // 留着旧的 requestedCommit 会让同一份内容被提交两次。
      this.requestedCommit = null;
      commit?.();
    }, 0);
  }
}
