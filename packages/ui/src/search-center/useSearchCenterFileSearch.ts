import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

/** 输入防抖：Host 侧搜索很快，但连续键入仍然会打出成串 RPC。 */
const SEARCH_DEBOUNCE_MS = 120;
/** 浮层只展示前若干条，够用户确认目标即可。 */
const SEARCH_RESULT_LIMIT = 50;

export interface SearchCenterFileSearchState {
  /** 实际发起查询的关键词（已去空白、已防抖）。输入框里的字与它不一致时说明还在防抖窗口内。 */
  effectiveQuery: string;
  /**
   * 当前结果对应的关键词。
   *
   * 与 effectiveQuery 不同：防抖结束后新查询已经发起，但结果还没回来，
   * 此时 effectiveQuery 已是新词、结果仍是旧词的。调用方要判断「结果能不能用」
   * 必须看这个字段，否则回车会打开上一个查询的旧结果。
   */
  resultsQuery: string;
  entries: WorkspaceFileEntry[];
  loading: boolean;
  error: string | null;
  /** 远端工作区还没接上：不回落到本机搜索，等它 ready。 */
  waitingForConnection: boolean;
  retry: () => void;
}

interface SearchState {
  query: string;
  entries: WorkspaceFileEntry[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: SearchState = { query: "", entries: [], loading: false, error: null };

/**
 * 搜索中心的文件搜索。
 *
 * 候选由 Host 侧的文件服务匹配（复用共享模糊打分并返回有界结果），
 * Renderer 不下载全量索引，也不在本地再维护第二份候选缓存。
 *
 * 旧响应不能进入当前结果：查询变化时 effect 清理会取消在途请求，
 * 请求号再兜一层，防止「先发的慢、后发的快」把旧结果写回列表。
 */
export function useSearchCenterFileSearch(params: {
  enabled: boolean;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  query: string;
}): SearchCenterFileSearchState {
  const { services, rpcReady, connectionKind } = useWorkspaceServicesResolution(
    params.workspaceAbsPath,
    params.remoteSessionId ?? null,
    params.workspaceIdentity ?? null,
    params.remoteTarget,
  );
  const fileService = services.fileService;
  const trimmedQuery = params.query.trim();
  const [debouncedQuery, setDebouncedQuery] = useState(trimmedQuery);
  const [state, setState] = useState<SearchState>(EMPTY_STATE);
  const [retryToken, setRetryToken] = useState(0);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(trimmedQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmedQuery]);

  useEffect(() => {
    if (!params.enabled) {
      // 浮层关闭：查询与结果一并清掉。搜索中心每次打开都从空查询开始，
      // 关闭期间留着上一次的查询，只会让重开时白发一次搜索、或闪出旧结果。
      requestIdRef.current += 1;
      setDebouncedQuery("");
      setState(EMPTY_STATE);
      return;
    }
    if (!debouncedQuery) {
      requestIdRef.current += 1;
      setState(EMPTY_STATE);
      return;
    }
    // 远端工作区还没就绪：宁可空着等，也不回落到本机搜索（会搜到另一台机器的文件）。
    if (!rpcReady) {
      requestIdRef.current += 1;
      setState({ query: debouncedQuery, entries: [], loading: false, error: null });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void fileService
      .searchWorkspaceFiles({
        rootPath: params.workspaceAbsPath,
        workspaceIdentity: params.workspaceIdentity,
        query: debouncedQuery,
        limit: SEARCH_RESULT_LIMIT,
        // 搜索中心只列文件：目录不参与文件快速打开。
        types: ["file"],
      })
      .then((entries) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        setState({ query: debouncedQuery, entries, loading: false, error: null });
      })
      .catch((error) => {
        if (cancelled || requestId !== requestIdRef.current) return;
        logger.warn("[search-center] 工作区文件搜索失败", { query: debouncedQuery, error });
        setState({
          query: debouncedQuery,
          entries: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    debouncedQuery,
    fileService,
    params.enabled,
    params.workspaceAbsPath,
    params.workspaceIdentity,
    retryToken,
    rpcReady,
  ]);

  const retry = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  return {
    effectiveQuery: debouncedQuery,
    resultsQuery: state.query,
    entries: state.entries,
    loading: state.loading,
    error: state.error,
    waitingForConnection: connectionKind === "remote-waiting",
    retry,
  };
}
