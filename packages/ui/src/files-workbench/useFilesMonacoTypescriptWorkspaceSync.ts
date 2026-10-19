import { useEffect, useMemo, useRef } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";
import { loadFilesMonaco } from "@/files-workbench/filesMonacoLoader.js";
import {
  cancelFilesMonacoTypescriptSync,
  invalidateFilesMonacoTypescriptWorkspaceCache,
  syncFilesMonacoTypescriptWorkspace,
  type FilesMonacoTypescriptWorkspaceEntry,
} from "@/files-workbench/filesMonacoTypescriptWorkspace.js";
import { filesMonacoTypescriptWorkspaceScope } from "@/files-workbench/filesMonacoTypescriptPath.js";

type ResolveServices = (workspace: FilesWorkspaceRef) => IServiceAccessor;

function isTypescriptRelevantFileChange(path?: string): boolean {
  if (!path) return true;
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return /\.(?:[cm]?[jt]sx?|d\.ts|json|jsonc|jsonl)$/i.test(name);
}

export function useFilesMonacoTypescriptWorkspaceSync(options: {
  enabled: boolean;
  entries: readonly FilesMonacoTypescriptWorkspaceEntry[];
  activeWorkspace?: FilesWorkspaceRef;
  activeBufferId?: string;
  resolveServices: ResolveServices;
}): void {
  const { enabled, entries, activeWorkspace, activeBufferId, resolveServices } = options;
  const watcherWorkspaces = useMemo(() => {
    const byScope = new Map<string, FilesWorkspaceRef>();
    if (activeWorkspace) {
      byScope.set(filesMonacoTypescriptWorkspaceScope(activeWorkspace), activeWorkspace);
    }
    for (const entry of entries) {
      byScope.set(filesMonacoTypescriptWorkspaceScope(entry.workspace), entry.workspace);
    }
    return [...byScope.values()];
  }, [activeWorkspace, entries]);
  const watcherWorkspaceKey = watcherWorkspaces
    .map((workspace) => filesMonacoTypescriptWorkspaceScope(workspace))
    .sort()
    .join("\n");
  const watcherWorkspacesRef = useRef(watcherWorkspaces);
  watcherWorkspacesRef.current = watcherWorkspaces;
  const syncInputRef = useRef({ entries, activeWorkspace, activeBufferId, resolveServices });
  syncInputRef.current = { entries, activeWorkspace, activeBufferId, resolveServices };

  useEffect(() => {
    if (!enabled) {
      cancelFilesMonacoTypescriptSync();
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadFilesMonaco()
        .then((monaco) => {
          if (cancelled) return;
          const input = syncInputRef.current;
          return syncFilesMonacoTypescriptWorkspace({
            monaco,
            entries: input.entries,
            activeWorkspace: input.activeWorkspace,
            activeBufferId: input.activeBufferId,
            resolveServices: input.resolveServices,
          });
        })
        .catch((error: unknown) => {
          if (!cancelled) logger.warn("[files-workbench] TypeScript 工作区解析失败", error);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      cancelFilesMonacoTypescriptSync();
    };
  }, [enabled, entries, activeWorkspace, activeBufferId, resolveServices]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let refreshTimer: number | undefined;
    const activeWatchers: Array<{
      service: ReturnType<ResolveServices>["fileWatcherService"];
      id: string;
      subscription: { dispose: () => void };
    }> = [];

    const scheduleSync = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const input = syncInputRef.current;
        void loadFilesMonaco()
          .then((monaco) => {
            if (disposed) return;
            return syncFilesMonacoTypescriptWorkspace({
              monaco,
              entries: input.entries,
              activeWorkspace: input.activeWorkspace,
              activeBufferId: input.activeBufferId,
              resolveServices: input.resolveServices,
            });
          })
          .catch((error: unknown) => {
            if (!disposed)
              logger.warn("[files-workbench] 文件变化后刷新 TypeScript 类型失败", error);
          });
      }, 400);
    };

    for (const workspace of watcherWorkspacesRef.current) {
      let services: ReturnType<ResolveServices>;
      try {
        services = resolveServices(workspace);
      } catch (error) {
        logger.warn("[files-workbench] 无法为工作区创建 TypeScript 文件监听", error);
        continue;
      }
      void services.fileWatcherService
        .watch({ path: workspace.workspacePath, recursive: true })
        .then(({ id }) => {
          if (disposed) {
            void services.fileWatcherService.unwatch({ id });
            return;
          }
          const subscription = services.fileWatcherService.onDynamicChange(id)((event) => {
            if (!isTypescriptRelevantFileChange(event.changedPath)) return;
            invalidateFilesMonacoTypescriptWorkspaceCache(
              filesMonacoTypescriptWorkspaceScope(workspace),
              event.changedPath,
            );
            scheduleSync();
          });
          activeWatchers.push({ service: services.fileWatcherService, id, subscription });
        })
        .catch((error: unknown) => {
          if (!disposed) logger.warn("[files-workbench] TypeScript 文件监听不可用", error);
        });
    }

    return () => {
      disposed = true;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      for (const watcher of activeWatchers) {
        watcher.subscription.dispose();
        void watcher.service.unwatch({ id: watcher.id });
      }
    };
  }, [enabled, resolveServices, watcherWorkspaceKey]);
}
