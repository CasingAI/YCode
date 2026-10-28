import {
  parseWorkspaceFileSearchPatterns,
  WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
} from "@zcode/shared/workspaceFileSearch";

/**
 * 文件树搜索的纯交互状态与派生规则。
 *
 * 文件树是关键词、包含/排除输入、展开状态、搜索被忽略文件和仅看改动的唯一 UI 所有者。
 * 这里只放可以在 Node/SSR 下直接验证的纯函数，避免把筛选语义分散到渲染代码里。
 */
export interface WorkspaceFileTreeSearchState {
  query: string;
  include: string;
  exclude: string;
  filtersExpanded: boolean;
  includeIgnored: boolean;
  changedOnly: boolean;
}

export interface WorkspaceFileTreeSearchIndexScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  includeIgnored: boolean;
}

export const WORKSPACE_FILE_SEARCH_RESULT_LIMIT = WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
/** 额外取一条用于判断是否超限，展示时再截断。 */
export const WORKSPACE_FILE_SEARCH_FILTER_LIMIT = WORKSPACE_FILE_SEARCH_RESULT_LIMIT + 1;

export function createWorkspaceFileTreeSearchState(): WorkspaceFileTreeSearchState {
  return {
    query: "",
    include: "",
    exclude: "",
    filtersExpanded: false,
    includeIgnored: false,
    changedOnly: false,
  };
}

/** 逗号分隔通配符：去掉首尾空白和空项；不处理转义与花括号展开。 */
export function splitWorkspaceFileTreeSearchPatternInput(raw: string): string[] {
  return parseWorkspaceFileSearchPatterns(raw);
}

export function hasWorkspaceFileTreeSearchQuery(
  state: Pick<WorkspaceFileTreeSearchState, "query">,
) {
  return state.query.trim().length > 0;
}

export function hasWorkspaceFileTreeSearchPatterns(
  state: Pick<WorkspaceFileTreeSearchState, "include" | "exclude">,
): boolean {
  return (
    splitWorkspaceFileTreeSearchPatternInput(state.include).length > 0 ||
    splitWorkspaceFileTreeSearchPatternInput(state.exclude).length > 0
  );
}

/** 只作用于索引候选范围的条件（包含/排除/搜索被忽略文件）。 */
export function hasWorkspaceFileTreeSearchRange(
  state: Pick<WorkspaceFileTreeSearchState, "include" | "exclude" | "includeIgnored">,
): boolean {
  return hasWorkspaceFileTreeSearchPatterns(state) || state.includeIgnored;
}

/**
 * 是否进入平铺搜索结果态。
 *
 * 仅开启「仅看改动」而没有关键词/范围条件时仍保留树形态。
 */
export function isWorkspaceFileTreeSearchActive(
  state: Pick<WorkspaceFileTreeSearchState, "query" | "include" | "exclude" | "includeIgnored">,
): boolean {
  return hasWorkspaceFileTreeSearchQuery(state) || hasWorkspaceFileTreeSearchRange(state);
}

/** 入口徽标数量：每个通配符算一项，开关各算一项。 */
export function countWorkspaceFileTreeSearchFilters(
  state: Pick<
    WorkspaceFileTreeSearchState,
    "include" | "exclude" | "includeIgnored" | "changedOnly"
  >,
): number {
  return (
    splitWorkspaceFileTreeSearchPatternInput(state.include).length +
    splitWorkspaceFileTreeSearchPatternInput(state.exclude).length +
    (state.includeIgnored ? 1 : 0) +
    (state.changedOnly ? 1 : 0)
  );
}

/** 清除筛选条件但保留关键词；展开状态属于 UI 偏好，也不重置。 */
export function clearWorkspaceFileTreeSearchFilters(
  state: WorkspaceFileTreeSearchState,
): WorkspaceFileTreeSearchState {
  return {
    ...state,
    include: "",
    exclude: "",
    includeIgnored: false,
    changedOnly: false,
  };
}

/** 点击目录结果时清除关键词和搜索范围，让树可以定位并展示该目录。 */
export function clearWorkspaceFileTreeSearchForDirectoryReveal(
  state: WorkspaceFileTreeSearchState,
): WorkspaceFileTreeSearchState {
  return clearWorkspaceFileTreeSearchFilters({ ...state, query: "" });
}

export function toggleWorkspaceFileTreeSearchFilterPanel(
  state: WorkspaceFileTreeSearchState,
): WorkspaceFileTreeSearchState {
  return { ...state, filtersExpanded: !state.filtersExpanded };
}

/** 本地 Worker 过滤选项；limit 多取一条用于截断判断。 */
export function getWorkspaceFileTreeSearchFilterOptions(state: WorkspaceFileTreeSearchState): {
  requireQuery: boolean;
  limit: number;
  include: string;
  exclude: string;
} {
  return {
    // 关键词或包含/排除存在时才要求 query；仅「搜索被忽略文件」允许空关键词列出候选。
    requireQuery:
      hasWorkspaceFileTreeSearchQuery(state) || hasWorkspaceFileTreeSearchPatterns(state),
    limit: WORKSPACE_FILE_SEARCH_FILTER_LIMIT,
    include: state.include,
    exclude: state.exclude,
  };
}

export function limitWorkspaceFileTreeSearchResults<T>(items: readonly T[]): {
  items: T[];
  hasMore: boolean;
} {
  if (items.length <= WORKSPACE_FILE_SEARCH_RESULT_LIMIT) {
    return { items: [...items], hasMore: false };
  }
  return {
    items: items.slice(0, WORKSPACE_FILE_SEARCH_RESULT_LIMIT),
    hasMore: true,
  };
}

/**
 * 索引隔离键：用途固定为 file-browser（由请求层强制），这里只区分身份、远程目标和忽略选项。
 * 关键词/包含/排除变化不会改变该键，因此只在本地 Worker 过滤，不重新拉取索引。
 */
export function getWorkspaceFileSearchIndexScopeKey(
  scope: WorkspaceFileTreeSearchIndexScope,
): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return [
    workspaceKey,
    scope.workspacePath,
    scope.workspaceRemoteSessionId?.trim() ?? "",
    scope.includeIgnored,
  ].join("\u0000");
}
