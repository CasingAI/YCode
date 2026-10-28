import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import type { FilterWorkspaceFileSearchCandidatesOptions } from "@zcode/shared/workspaceFileSearch";
import {
  createWorkerWorkspaceFileSearchFilterBackend,
  type WorkspaceFileSearchFilterBackend,
} from "./workspaceFileSearchFilterBackend.js";

export interface WorkspaceFileSearchFilterRequest {
  packed: string;
  rootPath: string;
  query: string;
  options: FilterWorkspaceFileSearchCandidatesOptions;
}

interface WorkspaceFileSearchFilterSnapshot {
  request: WorkspaceFileSearchFilterRequest;
  items: WorkspaceFileEntry[];
}

interface WorkspaceFileSearchFilterState {
  items: WorkspaceFileEntry[];
  filtering: boolean;
}

const EMPTY_ENTRIES: WorkspaceFileEntry[] = [];

/** 旧关键词、范围或索引的结果不得在下一次 effect 提交前冒充当前结果。 */
export function projectWorkspaceFileSearchFilterSnapshot(
  request: WorkspaceFileSearchFilterRequest,
  snapshot: WorkspaceFileSearchFilterSnapshot | null,
): WorkspaceFileSearchFilterState {
  const previous = snapshot?.request;
  const matches =
    previous !== undefined &&
    previous.packed === request.packed &&
    previous.rootPath === request.rootPath &&
    previous.query === request.query &&
    previous.options.include === request.options.include &&
    previous.options.exclude === request.options.exclude &&
    previous.options.allowedPaths === request.options.allowedPaths &&
    previous.options.limit === request.options.limit &&
    previous.options.requireQuery === request.options.requireQuery;
  return matches && snapshot
    ? { items: snapshot.items, filtering: false }
    : { items: EMPTY_ENTRIES, filtering: true };
}

/** 候选构建、范围过滤与 top-K 在 Worker 中完成；同步降级复用同一纯函数。 */
export function useWorkspaceFileSearchFilterEntries(
  packed: string,
  query: string,
  options: FilterWorkspaceFileSearchCandidatesOptions,
  rootPath: string,
): WorkspaceFileSearchFilterState {
  const backendRef = useRef<WorkspaceFileSearchFilterBackend | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceFileSearchFilterSnapshot | null>(null);
  const request = useMemo<WorkspaceFileSearchFilterRequest>(
    () => ({
      packed,
      rootPath,
      query,
      options: {
        include: options.include,
        exclude: options.exclude,
        allowedPaths: options.allowedPaths,
        limit: options.limit,
        requireQuery: options.requireQuery,
      },
    }),
    [
      options.allowedPaths,
      options.exclude,
      options.include,
      options.limit,
      options.requireQuery,
      packed,
      query,
      rootPath,
    ],
  );

  useEffect(() => {
    // effect 内创建确保严格模式清理后可以重建，放弃渲染也不会泄漏 Worker。
    const backend = (backendRef.current ??= createWorkerWorkspaceFileSearchFilterBackend());
    backend.setPacked(packed, rootPath);
  }, [packed, rootPath]);

  useEffect(() => {
    const backend = backendRef.current;
    if (!backend) return;
    let cancelled = false;
    void backend.filter(request.query, request.options).then((items) => {
      if (!cancelled) setSnapshot({ request, items: items ?? EMPTY_ENTRIES });
    });
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    return () => {
      backendRef.current?.dispose();
      backendRef.current = null;
    };
  }, []);

  return projectWorkspaceFileSearchFilterSnapshot(request, snapshot);
}
