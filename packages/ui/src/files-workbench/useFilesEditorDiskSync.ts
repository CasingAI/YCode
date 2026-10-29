import { useCallback, useEffect, useMemo, useRef } from "react";
import { logger } from "@/logger.js";
import {
  collectFilesDiskSyncGroups,
  filesDiskSyncGroupsKey,
  isFilesDiskWatchEventForPath,
  probeFilesDiskBuffer,
  type FilesDiskProbeFileService,
  type FilesDiskSyncGroup,
  type FilesDiskSyncTarget,
} from "@/files-workbench/filesEditorDiskSync.js";
import { useFilesEditorStore } from "@/files-workbench/FilesEditorStoreProvider.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type {
  FileWatchEvent,
} from "@zcode/shared";
import type {
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

interface FilesDiskWatcherService {
  watch(params: { path: string }): Promise<{ id: string }>;
  unwatch(params: { id: string }): Promise<void>;
  onDynamicChange(id: string): (handler: (event: FileWatchEvent) => void) => { dispose: () => void };
}

interface FilesEditorDiskSyncOptions {
  store: FilesEditorStore;
  enabled: boolean;
  /** 只探测活动视图里的已加载普通文本；大文件由 viewer 自己监视。 */
  isSavingBuffer: (bufferId: string) => boolean;
  resolveServices: (workspace: FilesWorkspaceRef) => {
    fileWatcherService: FilesDiskWatcherService;
    fileService: FilesDiskProbeFileService;
  };
  /** 干净缓冲发现外部变化时走 controller 的统一重载；失败时保留旧正文。 */
  onAutoReload: (bufferId: string) => Promise<boolean>;
}

interface WatchRegistration {
  cancelled: boolean;
  watcherId?: string;
  subscription?: { dispose: () => void };
  service?: FilesDiskWatcherService;
}

const PROBE_DEBOUNCE_MS = 40;

/**
 * 普通文本缓冲的目录 watcher，每个目录最多一个。
 *
 * 事件只触发版本 probe，不直接把事件当变化：只有确认版本不同才提示或重载。
 * `enabled=false`（文件界面不可见）时不注册 watcher，再进入或窗口 focus 时补一次 probe。
 */
export function useFilesEditorDiskSync(options: FilesEditorDiskSyncOptions): void {
  const { store, enabled, isSavingBuffer, resolveServices, onAutoReload } = options;
  const buffers = useFilesEditorStore((state) => state.buffers);
  const layout = useFilesEditorStore((state) => state.layout);
  const groups = useMemo(() => collectFilesDiskSyncGroups({ buffers, layout }), [buffers, layout]);
  const watchKey = filesDiskSyncGroupsKey(groups);
  const activationKey = groups
    .map((group) => group.targets.map((target) => target.id).sort().join(","))
    .sort()
    .join("|");

  const groupsRef = useRef<FilesDiskSyncGroup[]>(groups);
  groupsRef.current = groups;
  const isSavingRef = useRef(isSavingBuffer);
  isSavingRef.current = isSavingBuffer;
  const onAutoReloadRef = useRef(onAutoReload);
  onAutoReloadRef.current = onAutoReload;

  const seqRef = useRef(new Map<string, number>());
  const changeSeqRef = useRef(new Map<string, number>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const runProbe = useCallback(
    async (target: FilesDiskSyncTarget) => {
      const sequence = (seqRef.current.get(target.id) ?? 0) + 1;
      seqRef.current.set(target.id, sequence);
      const changeSeqAtStart = changeSeqRef.current.get(target.id) ?? 0;
      const isCurrentRequest = () =>
        seqRef.current.get(target.id) === sequence &&
        (changeSeqRef.current.get(target.id) ?? 0) === changeSeqAtStart;
      let result;
      try {
        result = await probeFilesDiskBuffer({
          store,
          bufferId: target.id,
          fileService: resolveServices(target.workspace).fileService,
          isCurrentRequest,
          isSaving: () => isSavingRef.current(target.id),
        });
      } catch (error) {
        // watcher 只是提示能力：probe 失败不能影响编辑。
        logger.warn("[files-workbench] 外部变化探测失败", { path: target.path, error });
        return;
      }
      if (result.kind !== "reload" || !isCurrentRequest()) return;
      await onAutoReloadRef.current(target.id);
    },
    [resolveServices, store],
  );

  const runProbeRef = useRef(runProbe);
  runProbeRef.current = runProbe;

  const scheduleProbe = useCallback((target: FilesDiskSyncTarget) => {
    if (isSavingRef.current(target.id)) return;
    const previous = timersRef.current.get(target.id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      timersRef.current.delete(target.id);
      void runProbeRef.current(target);
    }, PROBE_DEBOUNCE_MS);
    timersRef.current.set(target.id, timer);
  }, []);

  const scheduleProbeRef = useRef(scheduleProbe);
  scheduleProbeRef.current = scheduleProbe;

  useEffect(() => {
    if (!enabled) return;
    const registrations = new Map<string, WatchRegistration>();

    for (const group of groups) {
      const registration: WatchRegistration = { cancelled: false };
      registrations.set(group.key, registration);
      let services: ReturnType<FilesEditorDiskSyncOptions["resolveServices"]>;
      try {
        services = resolveServices(group.workspace);
      } catch (error) {
        logger.warn("[files-workbench] 外部变化监视服务不可用", {
          directory: group.directory,
          error,
        });
        continue;
      }
      const fileWatcherService = services.fileWatcherService;
      registration.service = fileWatcherService;
      void fileWatcherService
        .watch({ path: group.directory })
        .then(({ id }) => {
          if (registration.cancelled) {
            void fileWatcherService.unwatch({ id });
            return;
          }
          registration.watcherId = id;
          registration.subscription = fileWatcherService.onDynamicChange(id)((event) => {
            for (const target of groupsRef.current.flatMap((entry) => entry.targets)) {
              if (!isFilesDiskWatchEventForPath(event, target.path)) continue;
              if (isSavingRef.current(target.id)) continue;
              changeSeqRef.current.set(
                target.id,
                (changeSeqRef.current.get(target.id) ?? 0) + 1,
              );
              scheduleProbeRef.current(target);
            }
          });
        })
        .catch((error: unknown) => {
          if (registration.cancelled) return;
          logger.warn("[files-workbench] 监视文件目录失败", {
            directory: group.directory,
            error,
          });
        });
    }

    return () => {
      for (const registration of registrations.values()) {
        registration.cancelled = true;
        registration.subscription?.dispose();
        registration.subscription = undefined;
        const id = registration.watcherId;
        registration.watcherId = undefined;
        if (id && registration.service) {
          void registration.service.unwatch({ id }).catch(() => undefined);
        }
      }
    };
    // groups 只随 watchKey 变化；事件回调始终从 ref 读取最新目标集合。
  }, [enabled, resolveServices, watchKey]);

  useEffect(() => {
    if (!enabled) return;
    for (const group of groupsRef.current) {
      for (const target of group.targets) scheduleProbeRef.current(target);
    }
  }, [activationKey, enabled]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const probeAll = () => {
      for (const group of groupsRef.current) {
        for (const target of group.targets) scheduleProbeRef.current(target);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") probeAll();
    };
    window.addEventListener("focus", probeAll);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", probeAll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );
}
