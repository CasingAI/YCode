interface TaskFindNavigationState {
  activeIndex: number;
  navigationRequestId: number;
  query: string;
}

export function createTaskFindNavigationState(): TaskFindNavigationState {
  return {
    activeIndex: -1,
    navigationRequestId: 0,
    query: "",
  };
}

export function changeTaskFindSelection(
  state: TaskFindNavigationState,
  query: string,
  activeIndex: number,
): TaskFindNavigationState {
  // 查找命中状态没有变化时，保留引用；否则时间线 effect 回传相同结果会不断驱动 App 重渲染。
  // 重复导航由 navigateTaskFindSelection 负责递增 navigationRequestId，不受这里影响。
  if (state.query === query && state.activeIndex === activeIndex) {
    return state;
  }

  return {
    activeIndex,
    navigationRequestId: state.navigationRequestId,
    query,
  };
}

export function navigateTaskFindSelection(
  state: TaskFindNavigationState,
  query: string,
  activeIndex: number,
): TaskFindNavigationState {
  // 单命中环绕时 query/index 不变，导航身份必须在状态持有层独立递增。
  // 将三项状态放在同一次转换里，避免 App 的多个 setter 被后续维护拆散。
  return {
    activeIndex,
    navigationRequestId: state.navigationRequestId + 1,
    query,
  };
}
