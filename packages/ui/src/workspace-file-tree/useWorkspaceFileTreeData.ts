/* eslint-disable max-lines -- 文件树数据 hook 需要集中维护目录加载、watcher 刷新和 Git 状态竞态。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  WORKSPACE_FILE_TREE_WATCH_BULK_REFRESH_THRESHOLD,
  WORKSPACE_FILE_TREE_WATCH_DEBOUNCE_MS,
  WORKSPACE_FILE_TREE_WATCH_REFRESH_CONCURRENCY,
  WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS,
  WORKSPACE_FILE_TREE_REFRESH_GIT_TIMEOUT_MS,
} from "@/workspace-file-tree/constants.js";
import { replaceSetValue, toError } from "@/workspace-file-tree/helpers.js";
import {
  buildWorkspaceFileIgnoredPathSet,
  getWorkspaceFileDirectoryChildDepth,
  getWorkspaceFileParentDirectory,
  isWorkspaceFileTreeAutoFlattenableDirectory,
  isWorkspaceFilePathInside,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeNode,
} from "@/workspace-file-tree/model.js";
import { loadWorkspaceFileTreeGitStatus } from "@/workspace-file-tree/gitStatus.js";
import { useWorkspaceFileTreeConnectionRecovery } from "@/workspace-file-tree/useWorkspaceFileTreeConnectionRecovery.js";
import { useWorkspaceFileTreeWatchers } from "@/workspace-file-tree/useWorkspaceFileTreeWatchers.js";
import { getWorkspaceFileTreeRefreshDirectoryPaths } from "@/workspace-file-tree/refreshDirectories.js";
import { useWorkspaceFileTreeRows } from "@/workspace-file-tree/useWorkspaceFileTreeRows.js";

type WorkspaceFileTreeDirectoryLoadResult = "loaded" | "stale" | "failed" | "transportInterrupted";

function createWorkspaceFileTreeTimeoutError(label: string, timeoutMs: number) {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function withWorkspaceFileTreeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(createWorkspaceFileTreeTimeoutError(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function useWorkspaceFileTreeData({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  enableWorkspaceFeatures = true,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  enableWorkspaceFeatures?: boolean;
}) {
  const { services, rpcReady } = useWorkspaceServicesResolution(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const { fileService, fileWatcherService, gitService } = services;
  const recovery = useWorkspaceFileTreeConnectionRecovery({
    fileService,
    rpcReady,
    workspaceKey: workspaceIdentity?.trim() || workspacePath,
  });
  const {
    captureTransportReadToken,
    isTransportInterruption,
    markTransportInterruption,
    recoveryEpoch,
  } = recovery;
  // loadDirectory 的身份必须保持稳定：如果把 rpcReady 直接放进依赖，每次连接
  // 状态变化都会重跑 workspace 重置 effect 并清空已加载树。这里用 ref 读取即可。
  const rpcReadyRef = useRef(rpcReady);
  useEffect(() => {
    rpcReadyRef.current = rpcReady;
  }, [rpcReady]);
  const workspaceGenerationRef = useRef(0);
  const requestVersionRef = useRef(0);
  const directoryRequestVersionRef = useRef<Map<string, number>>(new Map());
  const gitStatusRequestVersionRef = useRef(0);
  const refreshBatchVersionRef = useRef(0);
  const pendingWatchRefreshPathsRef = useRef<Set<string>>(new Set());
  const watchRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingDirectoryPathsRef = useRef<Set<string>>(new Set());
  const loadedDirectoryPathsRef = useRef<Set<string>>(new Set());
  const [childrenByDirectory, setChildrenByDirectory] = useState<
    Map<string, WorkspaceFileTreeNode[]>
  >(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadedDirectoryPaths, setLoadedDirectoryPaths] = useState<Set<string>>(new Set());
  const [loadingDirectoryPaths, setLoadingDirectoryPaths] = useState<Set<string>>(new Set());
  const [errorByDirectory, setErrorByDirectory] = useState<Map<string, Error>>(new Map());
  const [gitStatusByPath, setGitStatusByPath] = useState<Map<string, WorkspaceFileGitStatus>>(
    new Map(),
  );
  const [gitStatusAvailable, setGitStatusAvailable] = useState(false);
  const [ignoredPathSet, setIgnoredPathSet] = useState<Set<string>>(new Set());
  const [refreshingLoadedDirectories, setRefreshingLoadedDirectories] = useState(false);
  const refreshingLoadedDirectoriesRef = useRef(false);
  const lastRecoveryEpochRef = useRef(0);
  const pendingRecoveryRefreshRef = useRef(false);

  useEffect(() => {
    loadingDirectoryPathsRef.current = loadingDirectoryPaths;
  }, [loadingDirectoryPaths]);

  useEffect(() => {
    loadedDirectoryPathsRef.current = loadedDirectoryPaths;
  }, [loadedDirectoryPaths]);

  const setDirectoryLoading = useCallback((path: string, loading: boolean) => {
    const next = replaceSetValue(loadingDirectoryPathsRef.current, path, loading);
    loadingDirectoryPathsRef.current = next;
    setLoadingDirectoryPaths(next);
  }, []);

  const setDirectoryLoaded = useCallback((path: string, loaded: boolean) => {
    const next = replaceSetValue(loadedDirectoryPathsRef.current, path, loaded);
    loadedDirectoryPathsRef.current = next;
    setLoadedDirectoryPaths(next);
  }, []);

  const invalidateDirectoryRequest = useCallback((directoryPath: string) => {
    directoryRequestVersionRef.current.set(
      directoryPath,
      (directoryRequestVersionRef.current.get(directoryPath) ?? 0) + 1,
    );
  }, []);

  const cancelRefreshBatch = useCallback(() => {
    refreshBatchVersionRef.current += 1;
  }, []);

  const pruneDirectorySubtree = useCallback(
    (directoryPath: string) => {
      for (const path of directoryRequestVersionRef.current.keys()) {
        if (isWorkspaceFilePathInside(directoryPath, path)) {
          // 目录被裁剪时不能删除请求序号，否则同路径重建会复用旧序号，让删除前的旧请求重新生效。
          invalidateDirectoryRequest(path);
        }
      }
      setChildrenByDirectory((current) => {
        const next = new Map(current);
        for (const path of current.keys()) {
          if (isWorkspaceFilePathInside(directoryPath, path)) {
            next.delete(path);
          }
        }
        return next;
      });
      setExpandedPaths((current) => {
        const next = new Set(
          [...current].filter((path) => !isWorkspaceFilePathInside(directoryPath, path)),
        );
        return next;
      });
      setErrorByDirectory((current) => {
        const next = new Map(current);
        for (const path of current.keys()) {
          if (isWorkspaceFilePathInside(directoryPath, path)) {
            next.delete(path);
          }
        }
        return next;
      });

      const nextLoaded = new Set(
        [...loadedDirectoryPathsRef.current].filter(
          (path) => !isWorkspaceFilePathInside(directoryPath, path),
        ),
      );
      loadedDirectoryPathsRef.current = nextLoaded;
      setLoadedDirectoryPaths(nextLoaded);

      const nextLoading = new Set(
        [...loadingDirectoryPathsRef.current].filter(
          (path) => !isWorkspaceFilePathInside(directoryPath, path),
        ),
      );
      loadingDirectoryPathsRef.current = nextLoading;
      setLoadingDirectoryPaths(nextLoading);
    },
    [invalidateDirectoryRequest],
  );

  const loadDirectory = useCallback(
    async (
      directoryPath: string,
      childDepth: number,
      options?: {
        force?: boolean;
        silent?: boolean;
        workspaceGeneration?: number;
      },
    ): Promise<WorkspaceFileTreeDirectoryLoadResult> => {
      const force = options?.force ?? false;
      const silent = options?.silent ?? false;
      const expectedWorkspaceGeneration =
        options?.workspaceGeneration ?? workspaceGenerationRef.current;
      if (workspaceGenerationRef.current !== expectedWorkspaceGeneration) {
        return "stale";
      }
      if (
        !force &&
        (loadingDirectoryPathsRef.current.has(directoryPath) ||
          loadedDirectoryPathsRef.current.has(directoryPath))
      ) {
        return "loaded";
      }
      // 已知当前 target 不能发 RPC（远程 waiting / transport 未恢复）时不发请求，
      // 也不写目录错误；未加载目录保持 loading，恢复后由 refreshLoadedDirectories 重读。
      if (!rpcReadyRef.current) {
        markTransportInterruption();
        if (!silent && !loadedDirectoryPathsRef.current.has(directoryPath)) {
          setDirectoryLoading(directoryPath, true);
        }
        return "transportInterrupted";
      }

      const requestVersion = requestVersionRef.current;
      // 手动刷新和 watcher 可能并发读取同一目录，目录级序号避免旧快照晚返回后覆盖新文件树。
      const directoryRequestVersion =
        (directoryRequestVersionRef.current.get(directoryPath) ?? 0) + 1;
      directoryRequestVersionRef.current.set(directoryPath, directoryRequestVersion);
      const isCurrentDirectoryRequest = () =>
        workspaceGenerationRef.current === expectedWorkspaceGeneration &&
        requestVersionRef.current === requestVersion &&
        directoryRequestVersionRef.current.get(directoryPath) === directoryRequestVersion;
      if (!silent) {
        setDirectoryLoading(directoryPath, true);
      }
      setErrorByDirectory((current) => {
        const next = new Map(current);
        next.delete(directoryPath);
        return next;
      });

      let keepWaitingForRecovery = false;
      // 读取开始前记录恢复信号序号：信号先到、旧读随后失败时，恢复门仍能消费它。
      const transportReadToken = captureTransportReadToken();
      try {
        const entries = await fileService.readdir({
          path: directoryPath,
          includeHidden: true,
        });
        if (!isCurrentDirectoryRequest()) {
          return "stale";
        }

        if (enableWorkspaceFeatures) {
          void gitService
            .getIgnoredPaths({
              workspacePath,
              paths: entries.map((entry) => entry.path),
            })
            .then((ignoredPaths) => {
              if (!isCurrentDirectoryRequest()) {
                return;
              }
              const ignoredPathKeys = buildWorkspaceFileIgnoredPathSet(ignoredPaths);
              setIgnoredPathSet((current) => {
                const next = new Set(current);
                for (const path of entries.map((entry) => entry.path)) {
                  next.delete(path.replace(/\\/g, "/").replace(/\/+$/, ""));
                }
                for (const path of ignoredPathKeys) {
                  next.add(path);
                }
                return next;
              });
            })
            .catch((error) => {
              const nextError = toError(error);
              logger.warn("[WorkspaceFileTree] 读取 Git ignored 状态失败", {
                workspacePath,
                path: directoryPath,
                error: nextError.message,
              });
            });
        }

        setChildrenByDirectory((current) => {
          const next = new Map(current);
          next.set(
            directoryPath,
            entries.map((entry) => ({
              path: entry.path,
              name: entry.name,
              type: entry.type,
              isSymbolicLink: entry.isSymbolicLink === true,
              depth: childDepth,
            })),
          );
          return next;
        });
        setDirectoryLoaded(directoryPath, true);

        if (entries.length === 1 && isWorkspaceFileTreeAutoFlattenableDirectory(entries[0])) {
          // 修复：flatten empty directories 只沿普通单子目录链预加载，避免软链接目录循环递归。
          void loadDirectory(entries[0].path, childDepth + 1, {
            silent: true,
            workspaceGeneration: expectedWorkspaceGeneration,
          });
        }
        return "loaded";
      } catch (error) {
        if (!isCurrentDirectoryRequest()) {
          return "stale";
        }
        const nextError = toError(error);
        // transport 中断不是目录业务错误：不写 errorByDirectory，不裁剪旧 children，
        // 由恢复门在 attachment / rpcReady 恢复后统一重读。
        if (isTransportInterruption(nextError)) {
          markTransportInterruption(transportReadToken);
          // 未加载目录保留 loading（等待恢复），已加载目录保留旧 children 并结束刷新态。
          // 修复：恢复重读是 silent 的，若此时目录仍从未加载，silent 失败同样不能清掉
          // 首次加载留下的等待态，否则根目录会显示成空目录。
          keepWaitingForRecovery = !loadedDirectoryPathsRef.current.has(directoryPath);
          logger.warn("[WorkspaceFileTree] 读取目录因连接中断暂停", {
            path: directoryPath,
            error: nextError.message,
          });
          return "transportInterrupted";
        }
        logger.warn("[WorkspaceFileTree] 读取目录失败", {
          path: directoryPath,
          error: nextError.message,
        });
        setErrorByDirectory((current) => {
          const next = new Map(current);
          next.set(directoryPath, nextError);
          return next;
        });
        return "failed";
      } finally {
        if (isCurrentDirectoryRequest() && !keepWaitingForRecovery) {
          setDirectoryLoading(directoryPath, false);
        }
      }
    },
    [
      captureTransportReadToken,
      enableWorkspaceFeatures,
      fileService,
      gitService,
      isTransportInterruption,
      markTransportInterruption,
      setDirectoryLoaded,
      setDirectoryLoading,
      workspacePath,
    ],
  );

  const loadGitStatus = useCallback(
    async (options?: { workspaceGeneration?: number }) => {
      const workspaceGeneration = options?.workspaceGeneration ?? workspaceGenerationRef.current;
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      if (!enableWorkspaceFeatures) {
        setGitStatusByPath(new Map());
        setGitStatusAvailable(false);
        return;
      }
      if (!rpcReadyRef.current) {
        markTransportInterruption();
        return;
      }
      const requestVersion = gitStatusRequestVersionRef.current + 1;
      gitStatusRequestVersionRef.current = requestVersion;
      const transportReadToken = captureTransportReadToken();
      try {
        const gitStatus = await loadWorkspaceFileTreeGitStatus({
          gitService,
          workspacePath,
        });
        if (
          gitStatusRequestVersionRef.current !== requestVersion ||
          workspaceGenerationRef.current !== workspaceGeneration
        ) {
          return;
        }
        setGitStatusAvailable(gitStatus.available);
        setGitStatusByPath(gitStatus.statusByPath);
      } catch (error) {
        if (
          gitStatusRequestVersionRef.current !== requestVersion ||
          workspaceGenerationRef.current !== workspaceGeneration
        ) {
          return;
        }
        const nextError = toError(error);
        if (isTransportInterruption(nextError)) {
          // Git 状态是附属信息，连接中断时保留旧值并等待恢复门统一重读，
          // 不能把断连当成「没有 Git 状态」清空变更入口。
          markTransportInterruption(transportReadToken);
          logger.warn("[WorkspaceFileTree] 读取 Git 状态因连接中断暂停", {
            workspacePath,
            error: nextError.message,
          });
          return;
        }
        logger.warn("[WorkspaceFileTree] 读取 Git 状态失败", {
          workspacePath,
          error: nextError.message,
        });
        // 修复：Git 状态读取异常时不能保留旧的变更过滤入口，否则用户会在过期状态下继续筛选文件树。
        setGitStatusAvailable(false);
        setGitStatusByPath(new Map());
      }
    },
    [
      captureTransportReadToken,
      enableWorkspaceFeatures,
      gitService,
      isTransportInterruption,
      markTransportInterruption,
      workspacePath,
    ],
  );

  const refreshDirectoryFromWatcher = useCallback(
    async (directoryPath: string, workspaceGeneration: number) => {
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      const refreshed = await loadDirectory(
        directoryPath,
        getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath),
        { force: true, silent: true, workspaceGeneration },
      );
      if (refreshed === "loaded" || refreshed === "stale" || refreshed === "transportInterrupted") {
        return;
      }
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      // 被监听目录被删除或重命名时先裁掉旧 subtree，再刷新父目录。
      pruneDirectorySubtree(directoryPath);
      const parentDirectoryPath = getWorkspaceFileParentDirectory(workspacePath, directoryPath);
      if (parentDirectoryPath) {
        await loadDirectory(
          parentDirectoryPath,
          getWorkspaceFileDirectoryChildDepth(workspacePath, parentDirectoryPath),
          { force: true, silent: true, workspaceGeneration },
        );
      }
    },
    [loadDirectory, pruneDirectorySubtree, workspacePath],
  );

  const refreshDirectoryManually = useCallback(
    async (directoryPath: string, workspaceGeneration: number) => {
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      // 手动刷新里的 readdir 失败通常是远程断连、权限或临时 I/O 错误；
      // 失败不等价于目录被删除，不能复用 watcher 的 subtree 裁剪逻辑，否则会清空旧树和错误状态。
      const transportReadToken = captureTransportReadToken();
      try {
        await withWorkspaceFileTreeTimeout(
          loadDirectory(
            directoryPath,
            getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath),
            { force: true, silent: true, workspaceGeneration },
          ),
          WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS,
          `workspace file tree refresh ${directoryPath}`,
        );
      } catch (error) {
        if (workspaceGenerationRef.current !== workspaceGeneration) {
          return;
        }
        invalidateDirectoryRequest(directoryPath);
        const nextError = toError(error);
        if (isTransportInterruption(nextError)) {
          // 超时也可能来自断连后的在途请求；已知离线时同样只挂起恢复，不写目录错误。
          markTransportInterruption(transportReadToken);
          logger.warn("[WorkspaceFileTree] 手动刷新目录因连接中断暂停", {
            path: directoryPath,
            error: nextError.message,
          });
          return;
        }
        logger.warn("[WorkspaceFileTree] 手动刷新目录超时或失败", {
          path: directoryPath,
          error: nextError.message,
        });
        setErrorByDirectory((current) => {
          const next = new Map(current);
          next.set(directoryPath, nextError);
          return next;
        });
      }
    },
    [
      captureTransportReadToken,
      invalidateDirectoryRequest,
      isTransportInterruption,
      loadDirectory,
      markTransportInterruption,
      workspacePath,
    ],
  );

  const refreshDirectoryPaths = useCallback(
    async (
      directoryPaths: string[],
      workspaceGeneration: number,
      refreshBatchVersion: number,
      refreshDirectory: (directoryPath: string, workspaceGeneration: number) => Promise<void>,
    ) => {
      const queue = [...new Set(directoryPaths)];
      const workerCount = Math.min(WORKSPACE_FILE_TREE_WATCH_REFRESH_CONCURRENCY, queue.length);
      const runWorker = async () => {
        while (
          queue.length > 0 &&
          workspaceGenerationRef.current === workspaceGeneration &&
          refreshBatchVersionRef.current === refreshBatchVersion
        ) {
          const directoryPath = queue.shift();
          if (directoryPath) {
            await refreshDirectory(directoryPath, workspaceGeneration);
          }
        }
      };

      await Promise.allSettled(Array.from({ length: workerCount }, runWorker));
    },
    [],
  );

  const refreshLoadedDirectories = useCallback(async () => {
    if (refreshingLoadedDirectoriesRef.current) {
      return;
    }
    const workspaceGeneration = workspaceGenerationRef.current;
    const refreshBatchVersion = refreshBatchVersionRef.current + 1;
    refreshBatchVersionRef.current = refreshBatchVersion;
    refreshingLoadedDirectoriesRef.current = true;
    setRefreshingLoadedDirectories(true);
    const directoryPaths = getWorkspaceFileTreeRefreshDirectoryPaths({
      workspacePath,
      expandedPaths,
      loadedDirectoryPaths: loadedDirectoryPathsRef.current,
    });
    // 手动刷新文件树过去只重读 workspace 根目录，已加载子目录仍沿用旧 children 缓存；
    // AI 重命名/新增文件发生在这些子目录时，旧路径会继续显示，新文件也不会出现。
    // 这里刷新所有已加载或已展开目录，不做全仓递归扫描，避免大仓库刷新成本失控。
    try {
      await refreshDirectoryPaths(
        directoryPaths,
        workspaceGeneration,
        refreshBatchVersion,
        refreshDirectoryManually,
      );
      // 用户可能在手动刷新旧 workspace 期间切换 workspace；
      // 旧刷新完成后不能再用旧 gitService 覆盖新 workspace 的 Git 状态。
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        try {
          await withWorkspaceFileTreeTimeout(
            loadGitStatus({ workspaceGeneration }),
            WORKSPACE_FILE_TREE_REFRESH_GIT_TIMEOUT_MS,
            "workspace file tree git refresh",
          );
        } catch (error) {
          if (
            workspaceGenerationRef.current === workspaceGeneration &&
            refreshBatchVersionRef.current === refreshBatchVersion
          ) {
            gitStatusRequestVersionRef.current += 1;
            const nextError = toError(error);
            logger.warn("[WorkspaceFileTree] 手动刷新 Git 状态超时或失败", {
              workspacePath,
              error: nextError.message,
            });
          }
        }
      }
    } finally {
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        refreshingLoadedDirectoriesRef.current = false;
        setRefreshingLoadedDirectories(false);
      }
    }
  }, [
    expandedPaths,
    loadGitStatus,
    refreshDirectoryManually,
    refreshDirectoryPaths,
    workspacePath,
  ]);

  // 恢复门只在真实读失败后产生 epoch；没有待恢复标记的透明 WSS↔RTC 换道不会走到这里。
  // 复用现有 refreshLoadedDirectories：根目录 + 已加载/展开目录 + Git 状态，避免每组件重试。
  useEffect(() => {
    if (recoveryEpoch === lastRecoveryEpochRef.current) {
      return;
    }
    if (refreshingLoadedDirectoriesRef.current) {
      pendingRecoveryRefreshRef.current = true;
      return;
    }
    if (!rpcReadyRef.current) {
      // epoch 先到、transport 还没 ready：保留待恢复标记，等 rpcReady 再产生新 epoch。
      markTransportInterruption();
      return;
    }
    lastRecoveryEpochRef.current = recoveryEpoch;
    void refreshLoadedDirectories();
  }, [markTransportInterruption, recoveryEpoch, refreshLoadedDirectories]);

  useEffect(() => {
    if (!pendingRecoveryRefreshRef.current || refreshingLoadedDirectories) {
      return;
    }
    pendingRecoveryRefreshRef.current = false;
    if (!rpcReadyRef.current) {
      markTransportInterruption();
      return;
    }
    lastRecoveryEpochRef.current = recoveryEpoch;
    void refreshLoadedDirectories();
  }, [
    markTransportInterruption,
    recoveryEpoch,
    refreshLoadedDirectories,
    refreshingLoadedDirectories,
  ]);

  const flushWatchRefreshQueue = useCallback(() => {
    const changedDirectoryPaths = [...pendingWatchRefreshPathsRef.current];
    pendingWatchRefreshPathsRef.current = new Set();
    if (changedDirectoryPaths.length === 0) {
      return;
    }
    const refreshPaths =
      changedDirectoryPaths.length > WORKSPACE_FILE_TREE_WATCH_BULK_REFRESH_THRESHOLD
        ? [workspacePath, ...expandedPaths]
        : changedDirectoryPaths;
    const workspaceGeneration = workspaceGenerationRef.current;
    const refreshBatchVersion = refreshBatchVersionRef.current;
    void refreshDirectoryPaths(
      refreshPaths,
      workspaceGeneration,
      refreshBatchVersion,
      refreshDirectoryFromWatcher,
    ).finally(() => {
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        void loadGitStatus({ workspaceGeneration });
      }
    });
  }, [
    expandedPaths,
    loadGitStatus,
    refreshDirectoryFromWatcher,
    refreshDirectoryPaths,
    workspacePath,
  ]);

  const enqueueWatchRefresh = useCallback(
    (directoryPath: string) => {
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      pendingWatchRefreshPathsRef.current.add(directoryPath);
      if (watchRefreshTimerRef.current) {
        clearTimeout(watchRefreshTimerRef.current);
      }
      watchRefreshTimerRef.current = setTimeout(() => {
        watchRefreshTimerRef.current = null;
        flushWatchRefreshQueue();
      }, WORKSPACE_FILE_TREE_WATCH_DEBOUNCE_MS);
    },
    [flushWatchRefreshQueue, workspacePath],
  );

  useEffect(() => {
    workspaceGenerationRef.current += 1;
    const workspaceGeneration = workspaceGenerationRef.current;
    requestVersionRef.current += 1;
    cancelRefreshBatch();
    directoryRequestVersionRef.current = new Map();
    loadingDirectoryPathsRef.current = new Set();
    loadedDirectoryPathsRef.current = new Set();
    setChildrenByDirectory(new Map());
    setExpandedPaths(new Set());
    setLoadedDirectoryPaths(new Set());
    setLoadingDirectoryPaths(new Set());
    setErrorByDirectory(new Map());
    setGitStatusByPath(new Map());
    setGitStatusAvailable(false);
    setIgnoredPathSet(new Set());
    refreshingLoadedDirectoriesRef.current = false;
    setRefreshingLoadedDirectories(false);
    pendingWatchRefreshPathsRef.current = new Set();
    if (watchRefreshTimerRef.current) {
      clearTimeout(watchRefreshTimerRef.current);
      watchRefreshTimerRef.current = null;
    }
    void loadDirectory(workspacePath, 0, {
      force: true,
      workspaceGeneration,
    });
    void loadGitStatus({ workspaceGeneration });
    return () => {
      cancelRefreshBatch();
    };
  }, [cancelRefreshBatch, loadDirectory, loadGitStatus, workspaceIdentity, workspacePath]);

  const rows = useWorkspaceFileTreeRows({
    workspacePath,
    childrenByDirectory,
    expandedPaths,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    errorByDirectory,
    gitStatusByPath,
  });

  const watchedDirectoryPaths = useMemo(
    () => new Set([workspacePath, ...expandedPaths]),
    [expandedPaths, workspacePath],
  );
  const effectiveWatchedDirectoryPaths = useMemo(
    () => (enableWorkspaceFeatures ? watchedDirectoryPaths : new Set<string>()),
    [enableWorkspaceFeatures, watchedDirectoryPaths],
  );

  useWorkspaceFileTreeWatchers({
    fileWatcherService,
    watchedDirectoryPaths: effectiveWatchedDirectoryPaths,
    onDirectoryChange: enqueueWatchRefresh,
  });

  return {
    rows,
    expandedPaths,
    setExpandedPaths,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    errorByDirectory,
    gitStatusByPath,
    gitStatusAvailable,
    ignoredPathSet,
    refreshingLoadedDirectories,
    loadDirectory,
    loadGitStatus,
    refreshLoadedDirectories,
    recovery,
    setLoadedDirectoryPaths,
    loadedDirectoryPathsRef,
  };
}
