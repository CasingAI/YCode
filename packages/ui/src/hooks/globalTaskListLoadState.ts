import type { ZCodeTaskListQuery } from "@zcode/services";

/**
 * Blocking loading is reserved for a query with no completed read yet.
 * Revisions and manual refreshes for an already-read query revalidate in the background.
 */
export function isGlobalTaskListQueryLoading(params: {
  hasWorkspaceScope: boolean;
  currentQueryKey: string;
  settledQueryKey: string | null;
}): boolean {
  return params.hasWorkspaceScope && params.currentQueryKey !== params.settledQueryKey;
}

interface GlobalTaskListQueryKeys {
  queryKey: string;
  displayQueryKey: string;
}

// 展示身份不包含分页 limit；source generation 仍由 readinessKey 单独维护。
export function buildGlobalTaskListQueryKeys(query: ZCodeTaskListQuery): GlobalTaskListQueryKeys {
  const displayQuery = { ...query };
  delete displayQuery.limit;
  return {
    queryKey: JSON.stringify(query),
    displayQueryKey: JSON.stringify(displayQuery),
  };
}

// 隐藏态返回稳定引用，避免下游 memo/effect 因每次渲染的新空数组反复触发。
const EMPTY_TASK_LIST_ITEMS: never[] = [];

interface GlobalTaskListDataView<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

// limit 只是分页窗口，不是展示身份；否则“显示更多”会清空列表并因内容收缩回顶。
// 展示身份不一致时必须返回空，避免不同 workspace/query 的行泄漏。
export function resolveGlobalTaskListDataView<T>(params: {
  hasWorkspaceScope: boolean;
  currentDisplayQueryKey: string;
  dataDisplayQueryKey: string | null;
  items: T[];
  total: number;
  hasMore: boolean;
  limit: number | undefined;
}): GlobalTaskListDataView<T> {
  if (!params.hasWorkspaceScope || params.dataDisplayQueryKey !== params.currentDisplayQueryKey) {
    return { items: EMPTY_TASK_LIST_ITEMS, total: 0, hasMore: false };
  }
  // 与服务端 normalizeLimit 对齐：只有正有限数才下推 LIMIT，0/负数/非有限值都视为无上限。
  const limit =
    params.limit !== undefined && Number.isFinite(params.limit) && params.limit > 0
      ? Math.floor(params.limit)
      : undefined;
  const items =
    limit !== undefined && params.items.length > limit
      ? params.items.slice(0, limit)
      : params.items;
  return {
    items,
    total: params.total,
    hasMore: params.hasMore || (limit !== undefined && params.total > limit),
  };
}
