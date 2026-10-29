import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FileTextWindow } from "@zcode/shared";
import { useShallow } from "zustand/react/shallow";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { resolveFilesWorkspaceServices } from "@/files-workbench/filesWorkspaceFileService.js";
import {
  filesWorkspaceKey,
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesLargeTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";
import {
  acquireFilesLargeTextWindow,
  getEmptyFilesLargeTextWindowSnapshot,
  type FilesLargeTextWindowLease,
  type FilesLargeTextWindowSnapshot,
  type FilesLargeTextWindowWatch,
} from "@/files-workbench/filesLargeTextWindowStore.js";
import type { FilesLargeTextNavigationTarget } from "@/files-workbench/filesLargeTextNavigation.js";
import type { FilesLargeTextBuffer } from "@/files-workbench/filesEditorTypes.js";
import { resolveFilesLargeTextExternalChange } from "@/files-workbench/filesLargeTextWindowErrors.js";
import { resolveFilesLargeTextWatchDirectory } from "@/files-workbench/filesLargeTextWindowTypes.js";
import { logger } from "@/logger.js";

const EMPTY_SNAPSHOT = getEmptyFilesLargeTextWindowSnapshot();
const noopSubscribe = () => () => {};

/**
 * 大文本固定块窗口 hook。
 *
 * - 服务解析复用现有工作区选择：本地走 base services，远程按 workspaceIdentity /
 *   remoteSessionId 选择会话服务；远端断开时直接抛出，不回退本机。
 * - React 侧只把读取函数注入 store；窗口、块索引、版本、请求序号都归 buffer
 *   作用域的 store 唯一所有，多个分屏共享同一份窗口。
 * - 窗口就绪后自动建立 Store 编辑基准；已有脏草稿时核心不会静默 rebase。
 * - `active=false`（隐藏保活）不发起首次读取；已有窗口继续保留，避免额外读盘。
 */
export function useFilesLargeTextWindow(
  buffer: FilesLargeTextBuffer,
  active: boolean,
): {
  snapshot: FilesLargeTextWindowSnapshot;
  navigate: (target: FilesLargeTextNavigationTarget) => void;
  refresh: () => void;
  retry: () => void;
} {
  const baseServices = useBaseWorkspaceServices();
  const filesEditorStore = useFilesEditorStoreApi();
  const editBaseVersion = useFilesEditorStore((state) => {
    const current = findFilesBuffer(state, buffer.id);
    return current && isFilesLargeTextBuffer(current) && isFilesBufferDirty(current)
      ? current.edit?.baseVersion
      : undefined;
  });
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const workspaceTabs = useOptionalTabStore(
    useShallow((state) => state.tabs.filter(isWorkspaceTab)),
  );
  const workspaceKey = filesWorkspaceKey(buffer.workspace);
  const remoteSessionId = buffer.workspace.workspaceRemoteSessionId?.trim() ?? "";

  const resolveServicesRef = useRef<() => ReturnType<typeof resolveFilesWorkspaceServices>>(() => {
    throw new Error("files-large-text-services-not-ready");
  });
  resolveServicesRef.current = () =>
    resolveFilesWorkspaceServices({
      workspace: buffer.workspace,
      baseServices,
      sessionsById,
      workspaceTabs,
    });

  const readRef = useRef<
    (params: {
      path: string;
      offset: number;
      length: number;
      expectedVersion?: string;
    }) => Promise<FileTextWindow>
  >(async () => {
    throw new Error("files-large-text-reader-not-ready");
  });
  readRef.current = async (params) =>
    resolveServicesRef.current().fileService.readTextFileWindow(params);

  // 每个 buffer entry 最多一个 watcher；store 保证多 split 只调用一次 start。
  const watchSource = useMemo<FilesLargeTextWindowWatch>(
    () => (onChange) => {
      let cancelled = false;
      let watcherId: string | null = null;
      let subscription: { dispose: () => void } | null = null;
      let fileWatcherService: ReturnType<
        typeof resolveFilesWorkspaceServices
      >["fileWatcherService"];
      try {
        fileWatcherService = resolveServicesRef.current().fileWatcherService;
      } catch (error) {
        logger.warn("[FilesLargeTextWindow] 文件监视服务不可用", {
          path: buffer.path,
          error: error instanceof Error ? error.message : String(error),
        });
        return () => {};
      }
      // 监视父目录：既是 fileWatcherService 的目录语义，也能在目标文件被
      // 原子替换后继续收到事件；事件仍由 startFilesLargeTextWatch 按完整路径过滤。
      const watchDirectory = resolveFilesLargeTextWatchDirectory(buffer.path);
      void fileWatcherService
        .watch({ path: watchDirectory })
        .then(({ id }) => {
          if (cancelled) {
            void fileWatcherService.unwatch({ id });
            return;
          }
          watcherId = id;
          subscription = fileWatcherService.onDynamicChange(id)(onChange);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          // 监视只影响变化提示；注册失败仍可手动刷新。
          logger.warn("[FilesLargeTextWindow] 监视大文件失败", {
            path: buffer.path,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return () => {
        cancelled = true;
        subscription?.dispose();
        subscription = null;
        const id = watcherId;
        watcherId = null;
        if (id) {
          void fileWatcherService.unwatch({ id }).catch((error: unknown) => {
            logger.warn("[FilesLargeTextWindow] 停止监视大文件失败", {
              path: buffer.path,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      };
    },
    [buffer.path],
  );

  const [lease, setLease] = useState<FilesLargeTextWindowLease | null>(null);
  const leaseDeps = useMemo(
    () => ({ bufferId: buffer.id, path: buffer.path, workspaceKey, remoteSessionId }),
    [buffer.id, buffer.path, remoteSessionId, workspaceKey],
  );
  const initialTotalBytes = buffer.totalBytes;
  // acquire 只接受「首次挂载时已知」的提示。恢复时 core 决策后补的 totalBytes
  // 必须走 setInitialTotalBytes：若放进 acquire 依赖，cleanup 会先 release，
  // refCount 归零时删掉 core 刚 seed 的首窗，随后新 entry 又从磁盘重读。
  const initialTotalBytesRef = useRef(initialTotalBytes);
  initialTotalBytesRef.current = initialTotalBytes;

  useEffect(() => {
    const nextLease = acquireFilesLargeTextWindow({
      owner: {
        bufferId: leaseDeps.bufferId,
        workspaceKey: leaseDeps.workspaceKey,
        remoteSessionId: leaseDeps.remoteSessionId,
        path: leaseDeps.path,
      },
      readWindow: (params) => readRef.current(params),
      initialTotalBytes: initialTotalBytesRef.current,
      watch: watchSource,
    });
    setLease(nextLease);
    return () => {
      setLease((current) => (current === nextLease ? null : current));
      nextLease.release();
    };
  }, [leaseDeps, watchSource]);

  // 元数据更新不改变 lease 身份，也不触发读取；seed 后 ensureLoaded 只做空操作。
  useEffect(() => {
    lease?.setInitialTotalBytes(initialTotalBytes);
  }, [initialTotalBytes, lease]);

  const snapshot = useSyncExternalStore(
    lease?.subscribe ?? noopSubscribe,
    lease?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    lease?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  );

  useEffect(() => {
    if (!lease) return;
    lease.setExpectedVersion(editBaseVersion);
  }, [editBaseVersion, lease]);

  const changeKind = snapshot.error?.kind;
  const observedVersion = snapshot.observedVersion;
  const phase = snapshot.phase;
  const cleanReady = phase === "ready" && snapshot.error === null && !snapshot.stale;
  useEffect(() => {
    // 加载中保持现有 banner；失败 / 离线不清掉已探测到的外部变化。
    if (phase === "loading" || phase === "idle") return;
    const next = resolveFilesLargeTextExternalChange(snapshot);
    if (!next) {
      if (cleanReady) filesEditorStore.getState().setLargeTextExternalChange(buffer.id, undefined);
      return;
    }
    const current = findFilesBuffer(filesEditorStore.getState(), buffer.id);
    const previous =
      current && isFilesLargeTextBuffer(current) ? current.externalChange : undefined;
    // 后续普通冲突错误不带版本时，保留探针已看到的新版本，供重载 / 草稿判断使用。
    const withVersion =
      next.kind === "changed" && next.observedVersion === undefined && previous?.kind === "changed"
        ? { ...next, observedVersion: previous.observedVersion }
        : next;
    filesEditorStore.getState().setLargeTextExternalChange(buffer.id, withVersion);
  }, [buffer.id, changeKind, cleanReady, filesEditorStore, observedVersion, phase, snapshot]);

  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (!lease) return;
    if (active && !wasActiveRef.current) {
      // 隐藏期间 watcher 可能漏事件；先激活再做有界版本探针。
      lease.setActive(true);
      lease.probeExternalChange();
    }
    wasActiveRef.current = active;
  }, [active, lease]);

  useEffect(() => {
    if (!lease || !active) return;
    const handleFocus = () => lease.probeExternalChange();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [active, lease]);

  const windowVersion = snapshot.window?.version;
  const windowTotalBytes = snapshot.window?.totalBytes;
  useEffect(() => {
    if (!active || windowVersion === undefined || windowTotalBytes === undefined) return;
    // 幂等；已有脏草稿时核心不会把补丁静默 rebase 到新版本。
    filesEditorStore.getState().initializeLargeTextEdit(buffer.id, windowVersion, windowTotalBytes);
  }, [active, buffer.id, filesEditorStore, windowTotalBytes, windowVersion]);

  useEffect(() => {
    if (!lease) return;
    lease.setActive(active);
    // totalBytes 未决策时不主动读盘：核心先做 size/binary decision，再 seed 首窗。
    if (active && initialTotalBytes !== undefined) {
      lease.ensureLoaded();
    }
    return () => {
      lease.setActive(false);
    };
  }, [active, initialTotalBytes, lease]);

  const navigate = useCallback(
    (target: FilesLargeTextNavigationTarget) => lease?.navigate(target),
    [lease],
  );
  const refresh = useCallback(() => lease?.refresh(), [lease]);
  const retry = useCallback(() => lease?.retry(), [lease]);

  return { snapshot, navigate, refresh, retry };
}
