import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  buildSearchCenterPathCandidateRow,
  resolveSearchCenterPathQuery,
} from "@/search-center/searchCenterPathQuery.js";
import type { SearchCenterRow } from "@/search-center/searchCenterState.js";

/** 输入防抖：Host 侧搜索很快，但连续键入仍然会打出成串 RPC。 */
const SEARCH_DEBOUNCE_MS = 120;
/** 浮层只展示前若干条，够用户确认目标即可。 */
const SEARCH_RESULT_LIMIT = 50;

/** 粘贴路径的存在性检查结果。 */
export type SearchCenterPathStatus =
  /** 输入不是路径，不需要检查。 */
  | "none"
  /** 正在检查（home 目录还没拿到，或 stat 在途）。 */
  | "checking"
  /** 存在且是文件：作为「直接打开」候选。 */
  | "file"
  /** 不存在。 */
  | "missing"
  /** 存在但是目录。 */
  | "directory";

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
  /** 路径检查对应的查询词：与 resultsQuery 同样用于判断「检查结果能不能用」。 */
  pathResultsQuery: string;
  /** 粘贴路径的检查状态。 */
  pathStatus: SearchCenterPathStatus;
  /** 粘贴路径展开后的绝对路径（用于提示文案）。 */
  pathAbsolutePath: string | null;
  /** 粘贴路径的直接打开候选；只有存在且是文件时才有值。 */
  pathCandidate: SearchCenterRow | null;
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

interface PathState {
  query: string;
  status: SearchCenterPathStatus;
  absolutePath: string | null;
}

const EMPTY_STATE: SearchState = { query: "", entries: [], loading: false, error: null };
const EMPTY_PATH_STATE: PathState = { query: "", status: "none", absolutePath: null };

/** 每个 Host（本地或远端 attachment）只取一次 home 目录。 */
const hostHomePathCache = new WeakMap<object, Promise<string | null>>();

function resolveHostHomePath(services: object): Promise<string | null> {
  const cached = hostHomePathCache.get(services);
  if (cached) {
    return cached;
  }
  const systemService = (services as { systemService?: { info?: () => Promise<{ homedir?: string }> } })
    .systemService;
  const promise =
    typeof systemService?.info === "function"
      ? systemService.info().then(
          (info) => info.homedir?.trim() || null,
          () => null,
        )
      : Promise.resolve(null);
  hostHomePathCache.set(services, promise);
  return promise;
}

/** stat 失败时区分「路径不存在」与其它错误：前者要明确告诉用户路径不存在。 */
function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * 搜索中心的文件搜索。
 *
 * 候选由 Host 侧的文件服务匹配（复用共享模糊打分并返回有界结果），
 * Renderer 不下载全量索引，也不在本地再维护第二份候选缓存。
 *
 * 旧响应不能进入当前结果：查询变化时 effect 清理会取消在途请求，
 * 请求号再兜一层，防止「先发的慢、后发的快」把旧结果写回列表。
 *
 * 粘贴进来的绝对路径 / `~` 路径另走一条检查：它可能指向工作区之外，
 * 工作区索引里没有这个文件，只能由文件服务确认它存在后作为「直接打开」候选。
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
  const [pathState, setPathState] = useState<PathState>(EMPTY_PATH_STATE);
  const [homePathState, setHomePathState] = useState<{
    services: object | null;
    value: string | null;
  }>({ services: null, value: null });
  const [retryToken, setRetryToken] = useState(0);
  const requestIdRef = useRef(0);
  const pathRequestIdRef = useRef(0);

  // `~` 展开需要当前 Host 的 home 目录：远程工作区必须用远端机器的 home，
  // 拿客户端本机的 home 展开会指向另一台机器上的文件。
  useEffect(() => {
    if (!params.enabled) {
      return;
    }
    let disposed = false;
    void resolveHostHomePath(services).then((homePath) => {
      if (disposed) {
        return;
      }
      setHomePathState({ services, value: homePath });
    });
    return () => {
      disposed = true;
    };
  }, [params.enabled, services]);

  // home 目录是否已经问过 Host：还没问过与「问过了但这台机器没有 home」是两回事，
  // 前者要等，后者才能判定成「这条路径展开不了」。
  const homeResolved = homePathState.services === services;
  const homePath = homeResolved ? homePathState.value : null;

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

  // 粘贴路径的存在性检查：路径可能指向工作区之外，工作区索引里没有它。
  useEffect(() => {
    if (!params.enabled) {
      pathRequestIdRef.current += 1;
      setPathState(EMPTY_PATH_STATE);
      return;
    }
    if (!debouncedQuery) {
      pathRequestIdRef.current += 1;
      setPathState(EMPTY_PATH_STATE);
      return;
    }
    const pathQuery = resolveSearchCenterPathQuery(debouncedQuery, homePath);
    if (!pathQuery.looksLikePath) {
      pathRequestIdRef.current += 1;
      setPathState({ query: debouncedQuery, status: "none", absolutePath: null });
      return;
    }
    if (!pathQuery.absolutePath) {
      pathRequestIdRef.current += 1;
      if (!homeResolved) {
        // home 目录还没到位：等它，不要把「还没解析出来」说成「路径不存在」。
        setPathState({ query: debouncedQuery, status: "checking", absolutePath: null });
        return;
      }
      // 这台机器没有 home：`~` 展开不了，退回普通关键词搜索。
      setPathState({ query: debouncedQuery, status: "none", absolutePath: null });
      return;
    }
    if (!rpcReady) {
      // 远端还没连上：路径候选先不提供，让「远程工作区连接中」的提示正常出现。
      pathRequestIdRef.current += 1;
      setPathState({ query: debouncedQuery, status: "none", absolutePath: null });
      return;
    }

    const requestId = pathRequestIdRef.current + 1;
    pathRequestIdRef.current = requestId;
    const absolutePath = pathQuery.absolutePath;
    setPathState((current) => ({ ...current, status: "checking" }));
    void fileService
      .stat({ path: absolutePath })
      .then((fileStat) => {
        if (requestId !== pathRequestIdRef.current) return;
        setPathState({
          query: debouncedQuery,
          status: fileStat.type === "file" ? "file" : "directory",
          absolutePath,
        });
      })
      .catch((error) => {
        if (requestId !== pathRequestIdRef.current) return;
        logger.debug("[search-center] 路径检查失败", { path: absolutePath, error });
        setPathState({
          query: debouncedQuery,
          status: isMissingPathError(error) ? "missing" : "none",
          absolutePath,
        });
      });
  }, [debouncedQuery, fileService, homePath, homeResolved, params.enabled, retryToken, rpcReady]);

  const retry = useCallback(() => {
    setRetryToken((token) => token + 1);
  }, []);

  const pathCandidate = useMemo<SearchCenterRow | null>(() => {
    if (pathState.status !== "file" || !pathState.absolutePath) {
      return null;
    }
    return buildSearchCenterPathCandidateRow(pathState.absolutePath);
  }, [pathState.absolutePath, pathState.status]);

  return {
    effectiveQuery: debouncedQuery,
    resultsQuery: state.query,
    entries: state.entries,
    pathResultsQuery: pathState.query,
    pathStatus: pathState.status,
    pathAbsolutePath: pathState.absolutePath,
    pathCandidate,
    loading: state.loading,
    error: state.error,
    waitingForConnection: connectionKind === "remote-waiting",
    retry,
  };
}
