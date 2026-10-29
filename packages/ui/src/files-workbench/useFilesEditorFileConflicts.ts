import { useCallback, useRef, useState } from "react";
import { findFilesBuffer, isFilesBufferDirty } from "@/files-workbench/filesEditorModel.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type {
  FilesSaveBufferRequestOptions,
  FilesSaveConflictInfo,
} from "@/files-workbench/filesEditorSaveIO.js";
import type {
  FilesBuffer,
  FilesSaveConflictDecision,
} from "@/files-workbench/filesEditorTypes.js";

export interface FilesSaveConflictState extends FilesSaveConflictInfo {
  /** 冲突弹窗只能覆盖探测到的这一版；删除时不允许覆盖重建。 */
  deleted: boolean;
}

type SaveBuffer = (
  buffer: FilesBuffer,
  options?: FilesSaveBufferRequestOptions,
) => Promise<boolean>;

export interface FilesEditorFileConflictsOptions {
  store: FilesEditorStore;
  /** 保存动作在 controller 内稍后定义，通过 ref 断开先有冲突弹窗、后有保存的循环。 */
  saveTextBufferRef: { current: SaveBuffer | undefined };
  resumeAfterResolvedSaveRef: { current: () => void };
  stopAfterFailedSaveRef: { current: () => void };
  reloadBufferFromDisk: (bufferId: string, options?: { allowDirty?: boolean }) => Promise<boolean>;
  /** 用户明确放弃大文件草稿后清理持久化记录，避免下次启动又被 blocked 草稿打扰。 */
  discardLargeTextDraft?: (bufferId: string) => Promise<void>;
}

/**
 * 保存冲突 / 外部变化 / 重载确认的唯一 UI 状态。
 *
 * 文本冲突的 Overwrite 绑定弹窗看到的 `observedVersion`；大文件补丁从不 force，
 * 只能取消或明确丢弃后重载。
 */
export function useFilesEditorFileConflicts(options: FilesEditorFileConflictsOptions) {
  const { store, reloadBufferFromDisk } = options;
  const [conflictBuffer, setConflictBuffer] = useState<FilesSaveConflictState | undefined>();
  const [largeConflictBuffer, setLargeConflictBuffer] = useState<
    FilesSaveConflictState | undefined
  >();
  const [reloadConfirmBufferId, setReloadConfirmBufferId] = useState<string | undefined>();
  const conflictRef = useRef<FilesSaveConflictState | undefined>(undefined);
  const largeConflictRef = useRef<FilesSaveConflictState | undefined>(undefined);

  const showConflict = useCallback((info: FilesSaveConflictInfo) => {
    const conflict: FilesSaveConflictState = {
      buffer: info.buffer,
      path: info.path,
      observedVersion: info.observedVersion,
      targetVersion: info.targetVersion,
      targetOnly: info.targetOnly,
      deleted: info.deleted,
    };
    // 大文件源版本冲突只能取消或丢弃草稿重载；纯另存为目标的已有版本
    // 可以显式确认目标版本后覆盖，不能把源草稿一并导向丢弃。
    if (info.buffer.kind === "large-text" && info.targetOnly !== true) {
      largeConflictRef.current = conflict;
      setLargeConflictBuffer(conflict);
      return;
    }
    conflictRef.current = conflict;
    setConflictBuffer(conflict);
  }, []);

  const clearConflicts = useCallback(() => {
    conflictRef.current = undefined;
    largeConflictRef.current = undefined;
    setConflictBuffer(undefined);
    setLargeConflictBuffer(undefined);
  }, []);

  const handleConflictDecision = useCallback(
    async (decision: FilesSaveConflictDecision | "cancel") => {
      const conflict = conflictBuffer;
      conflictRef.current = undefined;
      setConflictBuffer(undefined);
      if (!conflict) return;
      if (decision === "cancel") {
        options.stopAfterFailedSaveRef.current();
        return;
      }
      if (decision === "overwrite") {
        // 已删除文件只有在用户明确选择重建时才允许 expectedVersion=null。
        // 删除提示的按钮语义由调用方决定，这里统一走同一条保存入口。
        const saved = await options.saveTextBufferRef.current?.(conflict.buffer, {
          force: true,
          path: conflict.path,
          observedVersion: conflict.deleted ? null : conflict.observedVersion,
          targetVersion: conflict.targetVersion,
          ...(conflict.deleted ? { recreate: true } : undefined),
        });
        if (saved) {
          options.resumeAfterResolvedSaveRef.current();
        } else if (!conflictRef.current) {
          // 再次冲突会重新弹出确认；其它失败才停止剩余保存 / 关闭。
          options.stopAfterFailedSaveRef.current();
        }
        return;
      }
      const resolved = await reloadBufferFromDisk(conflict.buffer.id, { allowDirty: true });
      if (resolved) {
        if (conflict.buffer.kind === "large-text") {
          await options.discardLargeTextDraft?.(conflict.buffer.id);
        }
        options.resumeAfterResolvedSaveRef.current();
      } else {
        options.stopAfterFailedSaveRef.current();
      }
    },
    [conflictBuffer, options, reloadBufferFromDisk],
  );

  const handleLargeConflictDecision = useCallback(
    async (decision: "cancel" | "reload") => {
      const conflict = largeConflictBuffer;
      largeConflictRef.current = undefined;
      setLargeConflictBuffer(undefined);
      if (!conflict) return;
      if (decision === "cancel") {
        options.stopAfterFailedSaveRef.current();
        return;
      }
      // 先成功读取再替换草稿，离线或读取失败时不能提前丢弃补丁。
      const resolved = await reloadBufferFromDisk(conflict.buffer.id, { allowDirty: true });
      if (resolved) {
        await options.discardLargeTextDraft?.(conflict.buffer.id);
        options.resumeAfterResolvedSaveRef.current();
      } else {
        options.stopAfterFailedSaveRef.current();
      }
    },
    [largeConflictBuffer, options, reloadBufferFromDisk, store],
  );

  const requestReloadBuffer = useCallback(
    (bufferId: string) => {
      const buffer = findFilesBuffer(store.getState(), bufferId);
      if (!buffer) return;
      if (isFilesBufferDirty(buffer)) {
        setReloadConfirmBufferId(bufferId);
        return;
      }
      void reloadBufferFromDisk(bufferId).then(async (resolved) => {
        if (resolved && buffer.kind === "large-text") {
          await options.discardLargeTextDraft?.(bufferId);
        }
      });
    },
    [options, reloadBufferFromDisk, store],
  );

  const dismissExternalChange = useCallback(
    (bufferId: string) => {
      const buffer = findFilesBuffer(store.getState(), bufferId);
      if (!buffer) return;
      if (buffer.kind === "large-text") {
        store.getState().setLargeTextExternalChange(bufferId, undefined);
      } else if (buffer.kind === "text") {
        store.getState().setTextExternalChange(bufferId, undefined);
      }
    },
    [store],
  );

  const handleExternalReloadDecision = useCallback(
    async (decision: "cancel" | "reload" | "keep") => {
      const bufferId = reloadConfirmBufferId;
      setReloadConfirmBufferId(undefined);
      if (!bufferId) return;
      if (decision === "keep") {
        dismissExternalChange(bufferId);
        return;
      }
      if (decision === "cancel") return;
      const buffer = findFilesBuffer(store.getState(), bufferId);
      const resolved = await reloadBufferFromDisk(bufferId, { allowDirty: true });
      if (resolved && buffer?.kind === "large-text") {
        await options.discardLargeTextDraft?.(bufferId);
      }
    },
    [dismissExternalChange, options, reloadBufferFromDisk, reloadConfirmBufferId, store],
  );

  return {
    conflictBuffer,
    largeConflictBuffer,
    reloadConfirmBufferId,
    showConflict,
    clearConflicts,
    requestReloadBuffer,
    dismissExternalChange,
    handleConflictDecision,
    handleLargeConflictDecision,
    handleExternalReloadDecision,
  };
}
