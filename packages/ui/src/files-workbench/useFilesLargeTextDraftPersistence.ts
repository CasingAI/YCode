import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createFilesLargeTextDraftPersistence } from "@/files-workbench/filesLargeTextDraftPersistence.js";
import {
  createIndexedDbFilesLargeTextDraftStorage,
  filesLargeTextDraftBufferIdentity,
  type FilesDraftBuffer,
  type FilesLargeTextDraftOwner,
  type FilesLargeTextDraftPersistenceSnapshot,
  type FilesLargeTextDraftProbeResult,
  type FilesLargeTextDraftStorage,
} from "@/files-workbench/filesLargeTextDraftStorage.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";

/**
 * 大文件块补丁草稿持久化接线。
 *
 * 由 FilesWorkbenchSurface / controller 调用一次；Store 仍是编辑草稿唯一 owner，
 * 这里只负责启动订阅、首次激活恢复、beforeunload 最佳努力 flush，并向 banner
 * 暴露 blocked / error 快照。
 */

export interface UseFilesLargeTextDraftPersistenceOptions {
  store: FilesEditorStore;
  enabled?: boolean;
  /** 测试或自定义宿主可注入 fake；缺省使用 IndexedDB adapter。 */
  storage?: FilesLargeTextDraftStorage;
  /** 可选磁盘版本探测；缺省用运行时基准比较。 */
  probeFile?: (buffer: FilesDraftBuffer) => Promise<FilesLargeTextDraftProbeResult>;
}

export interface FilesLargeTextDraftPersistenceHandle {
  snapshot: FilesLargeTextDraftPersistenceSnapshot;
  flush: () => Promise<void>;
  /** 显式重试：忽略自动恢复去重，但仍不覆盖用户输入或保存中的缓冲。 */
  restoreOnActivate: (bufferId: string) => Promise<void>;
  discardBlockedDraft: (bufferId: string) => Promise<void>;
  /** SaveAs 成功后按旧 owner 精确清理已提交草稿；失败保留记录。 */
  discardCommittedDraft: (owner: FilesLargeTextDraftOwner) => Promise<boolean>;
  migrateBufferId: (oldBufferId: string, newBufferId: string) => Promise<boolean>;
}

type DraftController = ReturnType<typeof createFilesLargeTextDraftPersistence>;

const EMPTY_SNAPSHOT: FilesLargeTextDraftPersistenceSnapshot = {
  blocked: {},
  errors: {},
  pending: {},
};

export function useFilesLargeTextDraftPersistence(
  options: UseFilesLargeTextDraftPersistenceOptions,
): FilesLargeTextDraftPersistenceHandle {
  const { store, enabled = true } = options;
  const probeRef = useRef(options.probeFile);
  probeRef.current = options.probeFile;
  const hasProbe = options.probeFile !== undefined;
  const storage = useMemo(
    () => options.storage ?? createIndexedDbFilesLargeTextDraftStorage(),
    [options.storage],
  );
  // 控制器会订阅 Store，必须在 effect 中创建/销毁，避免 StrictMode 渲染阶段重复订阅。
  const [controller, setController] = useState<DraftController>();

  useEffect(() => {
    if (!enabled) {
      setController(undefined);
      return;
    }
    const next = createFilesLargeTextDraftPersistence({
      store,
      storage,
      ...(hasProbe ? { probeFile: (buffer: FilesDraftBuffer) => probeRef.current!(buffer) } : {}),
    });
    setController(next);
    return () => {
      next.dispose();
      setController((current) => (current === next ? undefined : current));
    };
  }, [enabled, hasProbe, storage, store]);

  useEffect(() => {
    if (!enabled || !controller) return;
    // 只对当前激活的大文件、同一 owner/base 首次恢复；revision 随每次输入变化，
    // 不能作为自动 load 的 key。load 失败后需要调用返回的 restoreOnActivate 显式重试。
    let seen: string | undefined;
    let lastActiveId: string | undefined;
    const tryActive = () => {
      const state = store.getState();
      const id = state.activeId;
      if (!id) {
        lastActiveId = undefined;
        return;
      }
      if (id !== lastActiveId) {
        lastActiveId = id;
        seen = undefined;
      }
      const buffer = state.buffers.find((candidate) => candidate.id === id);
      const path = buffer?.path;
      if (!buffer || !path) return;
      // 大文件须等 edit 初始化后再恢复；普通文本 / 预览也要检查 cold 记录，
      // 避免磁盘删除、缩小或转二进制后草稿静默消失。
      if (buffer.kind === "large-text" && !buffer.edit) return;
      const key = [
        buffer.kind,
        filesLargeTextDraftBufferIdentity({ path, workspace: buffer.workspace }),
        buffer.kind === "large-text" ? buffer.edit?.baseVersion : "",
        buffer.kind === "large-text" ? buffer.edit?.baseTotalBytes : "",
      ].join("\u0000");
      if (seen === key) return;
      seen = key;
      void controller.restoreOnActivate(id);
    };
    tryActive();
    return store.subscribe(tryActive);
  }, [controller, enabled, store]);

  useEffect(() => {
    if (!enabled || !controller || typeof window === "undefined") return;
    // beforeunload 不能等待异步完成；这里只尽可能启动 flush，不承诺落盘成功。
    const flush = () => void controller.flush();
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [controller, enabled]);

  const subscribe = useCallback(
    (listener: () => void) => (controller ? controller.subscribe(listener) : () => undefined),
    [controller],
  );
  const getSnapshot = useCallback(() => controller?.getSnapshot() ?? EMPTY_SNAPSHOT, [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return {
    snapshot,
    flush: useCallback(() => controller?.flush() ?? Promise.resolve(), [controller]),
    restoreOnActivate: useCallback(
      (bufferId: string) =>
        controller?.restoreOnActivate(bufferId, { force: true }) ?? Promise.resolve(),
      [controller],
    ),
    discardBlockedDraft: useCallback(
      (bufferId: string) => controller?.discardBlockedDraft(bufferId) ?? Promise.resolve(),
      [controller],
    ),
    discardCommittedDraft: useCallback(
      (owner: FilesLargeTextDraftOwner) =>
        controller?.discardCommittedDraft(owner) ?? Promise.resolve(false),
      [controller],
    ),
    migrateBufferId: useCallback(
      (oldBufferId: string, newBufferId: string) =>
        controller?.migrateBufferId(oldBufferId, newBufferId) ?? Promise.resolve(false),
      [controller],
    ),
  };
}
