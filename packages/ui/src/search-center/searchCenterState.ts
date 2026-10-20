import type { WorkspaceFileEntry } from "@zcode/shared";
import { areSearchCenterPathsEqual } from "@/search-center/searchCenterPathQuery.js";

/**
 * 两个搜索浮层的打开状态。
 *
 * 命令中心（⌘K / ⌘⇧P）与搜索中心（⌘P 快速打开）外观共用、但业务独立：
 * 任何时刻最多只有一个打开。把互斥关系收进一个状态对象里，
 * 就不依赖「谁先关谁」这类调用顺序约定。
 */
export interface SearchOverlayState {
  /** 命令中心是否打开。 */
  quickPickOpen: boolean;
  /** 搜索中心是否打开。 */
  searchCenterOpen: boolean;
  /**
   * 搜索中心已打开时再次唤起 ⌘P：递增后把焦点交回它的输入框并全选查询。
   * 不叠新的浮层实例。
   */
  searchCenterFocusRequestId: number;
}

export const INITIAL_SEARCH_OVERLAY_STATE: SearchOverlayState = {
  quickPickOpen: false,
  searchCenterOpen: false,
  searchCenterFocusRequestId: 0,
};

/** 打开搜索中心。已打开时不叠实例，只递增加焦请求号。 */
export function openSearchCenter(state: SearchOverlayState): SearchOverlayState {
  if (state.searchCenterOpen) {
    return { ...state, searchCenterFocusRequestId: state.searchCenterFocusRequestId + 1 };
  }
  return { ...state, quickPickOpen: false, searchCenterOpen: true };
}

/** 切换命令中心。打开时搜索中心必须让位。 */
export function toggleQuickPick(state: SearchOverlayState): SearchOverlayState {
  const quickPickOpen = !state.quickPickOpen;
  return {
    ...state,
    quickPickOpen,
    searchCenterOpen: quickPickOpen ? false : state.searchCenterOpen,
  };
}

/** 命令中心自身的开合（点遮罩关闭、Esc 关闭等）。 */
export function setQuickPickOpen(state: SearchOverlayState, open: boolean): SearchOverlayState {
  if (open) {
    return { ...state, quickPickOpen: true, searchCenterOpen: false };
  }
  return { ...state, quickPickOpen: false };
}

/** 搜索中心自身的开合。关闭不产生任何打开请求。 */
export function setSearchCenterOpen(state: SearchOverlayState, open: boolean): SearchOverlayState {
  return { ...state, searchCenterOpen: open };
}

export interface SearchCenterRow {
  path: string;
  name: string;
  relativePath: string;
}

/**
 * 当前可选项。
 *
 * 空查询给已打开文件；有查询时只给「结果属于当前查询」的候选——
 * 防抖窗口内、以及新查询已经发起但结果还没回来时，一律不给可选项，
 * 免得回车打开上一个查询的旧结果。
 *
 * 粘贴进来的路径（绝对路径 / `~` 路径）单独占一个「直接打开」候选并置顶：
 * 路径可以指向工作区之外，工作区索引里根本没有它，只能由路径检查给出。
 * 它同时命中工作区索引时只出现一次。
 */
export function resolveSearchCenterRows(params: {
  trimmedQuery: string;
  /** 当前结果对应的查询词。 */
  resultsQuery: string;
  entries: readonly SearchCenterRow[];
  openedFiles: readonly SearchCenterRow[];
  /** 粘贴路径的存在性检查给出的直接打开候选。 */
  pathCandidate?: SearchCenterRow | null;
}): SearchCenterRow[] {
  if (!params.trimmedQuery) {
    return [...params.openedFiles];
  }
  if (params.resultsQuery !== params.trimmedQuery) {
    return [];
  }
  const rows = [...params.entries];
  const candidate = params.pathCandidate;
  if (candidate) {
    const duplicateIndex = rows.findIndex((row) => areSearchCenterPathsEqual(row.path, candidate.path));
    if (duplicateIndex >= 0) {
      rows.splice(duplicateIndex, 1);
    }
    rows.unshift(candidate);
  }
  return rows;
}

export interface SearchCenterSelectionOutcome {
  /** 是否是「确认打开」而不是「取消」。 */
  confirmed: boolean;
  /** 确认打开时的目标文件；取消时为 null。 */
  entry: WorkspaceFileEntry | null;
}

/**
 * 关闭浮层时的意图判定。
 *
 * 取消（Esc、点遮罩）只关浮层，不产生任何打开请求，也不抢走原焦点；
 * 只有确认选中某一行才会把目标文件交给调用方去走打开链路。
 */
export function resolveSearchCenterSelection(
  row: SearchCenterRow | null,
): SearchCenterSelectionOutcome {
  if (!row) {
    return { confirmed: false, entry: null };
  }
  return {
    confirmed: true,
    entry: {
      path: row.path,
      name: row.name,
      relativePath: row.relativePath,
      type: "file",
    },
  };
}
