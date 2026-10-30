import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import type { IFileService } from "@zcode/services";
import {
  packWorkspaceFileEntries,
  unpackWorkspaceFileEntries,
} from "@zcode/shared/workspaceFileEntriesCodec";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { fetchWorkspaceFileEntriesPacked } from "@/workspace-file-search/fetchWorkspaceFileEntries.js";
import { useWorkspaceFileSearchFilterEntries } from "@/workspace-file-search/useWorkspaceFileSearchFilter.js";
import type { WorkspaceFileTreeConnectionRecovery } from "@/workspace-file-tree/useWorkspaceFileTreeConnectionRecovery.js";
import { findExactWorkspaceFileEntry } from "@/workspace-file-tree/workspaceFilePathMatch.js";
import {
  getWorkspaceFileSearchIndexScopeKey,
  getWorkspaceFileTreeSearchFilterOptions,
  limitWorkspaceFileTreeSearchResults,
} from "@/workspace-file-tree/workspaceFileTreeSearchModel.js";

export const WORKSPACE_FILE_BROWSER_SEARCH_PURPOSE = "file-browser" as const;

interface WorkspaceFileSearchIndexState {
  entries: WorkspaceFileEntry[];
  loading: boolean;
  loaded: boolean;
  error: Error | null;
  refresh: () => void;
}

interface WorkspaceFileSearchIndexSnapshot {
  key: string;
  service: IFileService | null;
  packed: string;
  loaded: boolean;
  error: Error | null;
}

const EMPTY_WORKSPACE_FILE_SEARCH_INDEX_SNAPSHOT: WorkspaceFileSearchIndexSnapshot = {
  key: "",
  service: null,
  packed: "",
  loaded: false,
  error: null,
};

/**
 * 文件浏览器搜索索引。
 *
 * - 用途固定为 file-browser，隔离 Host 侧为文件引用设计的过滤语义；
 * - 身份、路径、远程目标和「搜索被忽略文件」共同决定索引键，关键词/包含/排除不触发拉取；
 * - 显式刷新只通过 length 请求的 refresh 选项绕过 TTL，分块 range 读取复用同一份扫描结果；
 * - 旧作用域的异步响应通过请求版本丢弃，索引快照按作用域键存放，切换后不会先渲染旧结果。
 */
export function useWorkspaceFileSearchIndex({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  includeIgnored = false,
  enabled,
  recovery,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  includeIgnored?: boolean;
  enabled: boolean;
  recovery: WorkspaceFileTreeConnectionRecovery;
}): WorkspaceFileSearchIndexState {
  const { services, rpcReady } = useWorkspaceServicesResolution(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const { fileService } = services;
  const {
    captureTransportReadToken,
    isTransportInterruption,
    markTransportInterruption,
    recoveryEpoch,
  } = recovery;
  const scopeKey = useMemo(
    () =>
      getWorkspaceFileSearchIndexScopeKey({
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
        includeIgnored,
      }),
    [includeIgnored, workspaceIdentity, workspacePath, workspaceRemoteSessionId],
  );
  // packed 直存（Host 返回列式字符串）：树渲染用 useMemo unpack，搜索态直透 worker。
  const [snapshot, setSnapshot] = useState<WorkspaceFileSearchIndexSnapshot>(
    EMPTY_WORKSPACE_FILE_SEARCH_INDEX_SNAPSHOT,
  );
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  // 连接中断后保持等待态：旧快照可继续显示，但 loading 不能被 finally 提前清掉。
  const [transportPending, setTransportPending] = useState(false);
  const requestVersionRef = useRef(0);
  // 记录「本次请求前发生过显式刷新」；只有 length 请求携带 refresh，range 分块不重复强制刷新。
  const refreshRequestRef = useRef(0);
  const lastRecoveryEpochRef = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const keyMatches = snapshot.key === scopeKey && snapshot.service === fileService;
  const entries = useMemo<WorkspaceFileEntry[]>(
    () =>
      keyMatches && snapshot.packed
        ? unpackWorkspaceFileEntries(snapshot.packed, workspacePath)
        : [],
    [keyMatches, snapshot.packed, workspacePath],
  );

  const refresh = useCallback(() => {
    refreshRequestRef.current += 1;
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      // 关闭搜索后使在途请求过期，避免树形态下仍把旧结果写回。
      requestVersionRef.current += 1;
      setLoadingKey(null);
      setTransportPending(false);
      return;
    }

    const forceRecoveryRefresh = recoveryEpoch !== lastRecoveryEpochRef.current;
    if (!rpcReady) {
      // 当前 target 不能发 RPC：使在途请求过期，保留旧快照，等待恢复门统一重拉。
      requestVersionRef.current += 1;
      markTransportInterruption();
      setLoadingKey(scopeKey);
      setTransportPending(true);
      return;
    }

    let cancelled = false;
    const currentVersion = requestVersionRef.current + 1;
    requestVersionRef.current = currentVersion;
    const forceRefresh = refreshRequestRef.current > 0 || forceRecoveryRefresh;
    if (forceRefresh) {
      refreshRequestRef.current = 0;
    }
    lastRecoveryEpochRef.current = recoveryEpoch;
    setTransportPending(false);

    // 首次加载或换作用域时清空旧快照；同作用域刷新/恢复保留旧结果，
    // 避免文件搜索在重拉期间先闪空。
    setLoadingKey(scopeKey);
    setSnapshot((current) => {
      if (current.key === scopeKey && current.service === fileService && current.loaded) {
        return current;
      }
      return {
        key: scopeKey,
        service: fileService,
        packed: "",
        loaded: false,
        error: null,
      };
    });

    const transportReadToken = captureTransportReadToken();
    void fetchWorkspaceFileEntriesPacked(fileService, workspacePath, {
      workspaceIdentity,
      purpose: WORKSPACE_FILE_BROWSER_SEARCH_PURPOSE,
      includeIgnored,
      refresh: forceRefresh,
    })
      .then((result) => {
        if (cancelled || requestVersionRef.current !== currentVersion) {
          return;
        }
        setTransportPending(false);
        setSnapshot({
          key: scopeKey,
          service: fileService,
          packed: result,
          loaded: true,
          error: null,
        });
      })
      .catch((nextError) => {
        if (cancelled || requestVersionRef.current !== currentVersion) {
          return;
        }
        const actualError = nextError instanceof Error ? nextError : new Error(String(nextError));
        if (isTransportInterruption(actualError)) {
          // 断连不是索引业务错误：保留同作用域旧结果，等待新 attachment / rpcReady 恢复。
          markTransportInterruption(transportReadToken);
          setTransportPending(true);
          setSnapshot((current) =>
            current.key === scopeKey && current.service === fileService
              ? current.error
                ? { ...current, error: null }
                : current
              : {
                  key: scopeKey,
                  service: fileService,
                  packed: "",
                  loaded: false,
                  error: null,
                },
          );
          return;
        }
        setTransportPending(false);
        setSnapshot({
          key: scopeKey,
          service: fileService,
          packed: "",
          loaded: false,
          error: actualError,
        });
      })
      .finally(() => {
        if (!cancelled && requestVersionRef.current === currentVersion) {
          setLoadingKey((current) => (current === scopeKey ? null : current));
        }
      });
    // 连接换代、切换范围或卸载后，旧请求只完成网络读取，不得写回 UI 快照。
    return () => {
      cancelled = true;
    };
  }, [
    captureTransportReadToken,
    enabled,
    fileService,
    includeIgnored,
    isTransportInterruption,
    markTransportInterruption,
    recoveryEpoch,
    refreshVersion,
    rpcReady,
    scopeKey,
    workspaceIdentity,
    workspacePath,
  ]);

  return {
    entries,
    loading: enabled && (transportPending || loadingKey === scopeKey || !keyMatches),
    loaded: keyMatches && snapshot.loaded,
    error: keyMatches ? snapshot.error : null,
    refresh,
  };
}

export function useWorkspaceFileSearchResults({
  entries,
  query,
  include,
  exclude,
  allowedPaths,
  workspacePath,
}: {
  entries: WorkspaceFileEntry[];
  query: string;
  include: string;
  exclude: string;
  allowedPaths?: string[];
  workspacePath: string;
}): { entries: WorkspaceFileEntry[]; hasMore: boolean; filtering: boolean } {
  // 打分在 Web Worker 执行（与 @ 文件候选共用同一过滤语义与降级路径）。
  // 入参是树已解包的 entries（渲染复用），这里重新 pack 一次（~31ms@37 万）
  // 交给 worker——避免调用方为搜索单独维护一份 packed 状态。
  // limit 多取一条用于第 1001 项截断判断。
  const packed = useMemo(() => packWorkspaceFileEntries(entries), [entries]);
  const options = useMemo(
    () => ({
      ...getWorkspaceFileTreeSearchFilterOptions({
        query,
        include,
        exclude,
        filtersExpanded: false,
        includeIgnored: false,
        changedOnly: false,
      }),
      allowedPaths,
    }),
    [allowedPaths, exclude, include, query],
  );
  const { items, filtering } = useWorkspaceFileSearchFilterEntries(
    packed,
    query,
    options,
    workspacePath,
  );
  // 粘贴进来的路径要"识别上这个路径"：精确命中的条目置顶，
  // 不与模糊结果混在一起（共享打分器已给精确命中最低分，这里只做置顶保证）。
  const orderedItems = useMemo(() => {
    const exact = findExactWorkspaceFileEntry(items, query);
    if (!exact) {
      return items;
    }
    return [exact, ...items.filter((item) => item !== exact)];
  }, [items, query]);
  const limited = useMemo(() => limitWorkspaceFileTreeSearchResults(orderedItems), [orderedItems]);
  return {
    entries: limited.items,
    hasMore: limited.hasMore,
    filtering,
  };
}
