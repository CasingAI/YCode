/**
 * 启动屏退出保持期的状态机（见 docs/specs/startup-brand-animation.md）。
 *
 * 抽成纯模型是为了让「门控翻转 → 收尾动画 → 卸载」这段时序可被单测覆盖：
 * 保持期一旦被提前结束，阶段 2 的图标定格就整段看不见；门控回退时若不撤销保持期，
 * 又会把定格画面当成"加载中"继续显示。
 */
export interface StartupBrandExitHoldState {
  /** 上一次的门控值，用来识别 true → false 的那一帧。 */
  wasBlocked: boolean;
  /** 是否处于退出保持期：门控已解除，但启动屏仍留在屏幕上播收尾动画。 */
  isExitHold: boolean;
}

export interface StartupBrandExitHoldStep {
  state: StartupBrandExitHoldState;
  /** 本次推进是否要启动收尾动画的计时器。 */
  startSettleTimer: boolean;
}

export function createStartupBrandExitHoldState(isBlocked: boolean): StartupBrandExitHoldState {
  return { wasBlocked: isBlocked, isExitHold: false };
}

export function advanceStartupBrandExitHold(
  state: StartupBrandExitHoldState,
  isBlocked: boolean,
): StartupBrandExitHoldStep {
  // 回到阻塞态必须撤销保持期：首次启动创建回退 workspace 等场景会让门控反复翻转。
  if (isBlocked) {
    return { state: { wasBlocked: true, isExitHold: false }, startSettleTimer: false };
  }
  // 门控本来就已解除，说明启动屏早已退场，不重复进入保持期。
  if (!state.wasBlocked) {
    return { state: { wasBlocked: false, isExitHold: false }, startSettleTimer: false };
  }
  return { state: { wasBlocked: false, isExitHold: true }, startSettleTimer: true };
}

/** 收尾动画播完，保持期结束。 */
export function settleStartupBrandExitHold(
  state: StartupBrandExitHoldState,
): StartupBrandExitHoldState {
  return { wasBlocked: state.wasBlocked, isExitHold: false };
}
