import { useCallback, useRef } from "react";
import {
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { filesActiveTextBuffer } from "@/files-workbench/filesActiveTextBuffer.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { FilesTextBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 文件编辑器的保存动作：保存当前文件、另存为、全部保存。
 *
 * 「全部保存」按打开顺序逐个保存脏文件，遇到需要用户处理的冲突或另存为就暂停，
 * 用户处理完再续接；用户取消或保存失败即停止，剩余文件保持未保存。
 */

export interface FilesEditorSaveActions {
  /** 保存当前激活的文本文件；没有可保存的文本文件时不做任何事。 */
  saveActiveFile: () => Promise<boolean>;
  /** 保存指定标签（标签栏保存按钮用）；不是可保存的文本文件时不做任何事。 */
  saveBufferById: (bufferId: string) => void;
  /** 另存为当前激活的文本文件；没有可保存的文本文件时不做任何事。 */
  saveActiveFileAs: () => boolean;
  /** 全部保存：按打开顺序逐个保存脏文件。 */
  saveAllFiles: () => Promise<void>;
  /** 冲突 / 另存为处理完成后续接全部保存队列。 */
  resumeSaveAll: () => Promise<void>;
  /** 用户取消或保存失败：停止全部保存，剩余文件保持未保存。 */
  stopSaveAll: () => void;
}

export function useFilesEditorSaveActions(options: {
  store: FilesEditorStore;
  saveTextBuffer: (
    buffer: FilesTextBuffer,
    options?: { force?: boolean; path?: string },
  ) => Promise<boolean>;
  setSaveAsBufferId: (bufferId: string | undefined) => void;
}): FilesEditorSaveActions {
  const { store, saveTextBuffer, setSaveAsBufferId } = options;
  /** 全部保存的待处理队列：按打开顺序逐个保存，遇到需要用户处理的弹窗即暂停。 */
  const saveAllQueueRef = useRef<string[] | undefined>(undefined);

  const saveActiveFile = useCallback(async () => {
    const buffer = filesActiveTextBuffer(store.getState().buffers, store.getState().activeId);
    if (!buffer) {
      return false;
    }
    return saveTextBuffer(buffer);
  }, [saveTextBuffer, store]);

  const saveBufferById = useCallback(
    (bufferId: string) => {
      const buffer = findFilesBuffer(store.getState(), bufferId);
      if (!buffer || !isFilesTextBuffer(buffer)) return;
      void saveTextBuffer(buffer);
    },
    [saveTextBuffer, store],
  );

  const saveActiveFileAs = useCallback(() => {
    const buffer = filesActiveTextBuffer(store.getState().buffers, store.getState().activeId);
    if (!buffer) {
      return false;
    }
    setSaveAsBufferId(buffer.id);
    return true;
  }, [setSaveAsBufferId, store]);

  const processSaveAllQueue = useCallback(async () => {
    const queue = saveAllQueueRef.current;
    if (!queue || queue.length === 0) {
      saveAllQueueRef.current = undefined;
      return;
    }
    const next = queue[0];
    if (next === undefined) {
      saveAllQueueRef.current = undefined;
      return;
    }
    saveAllQueueRef.current = queue.slice(1);
    const buffer = findFilesBuffer(store.getState(), next);
    if (!buffer || !isFilesTextBuffer(buffer)) {
      await processSaveAllQueue();
      return;
    }
    const saved = await saveTextBuffer(buffer);
    if (!saved) {
      // 冲突或另存为：等待用户处理，处理完成后由 resumeSaveAll 续接。
      return;
    }
    await processSaveAllQueue();
  }, [saveTextBuffer, store]);

  const saveAllFiles = useCallback(async () => {
    if (saveAllQueueRef.current) {
      return;
    }
    const state = store.getState();
    const pending = state.openIds.filter((id) => {
      const buffer = findFilesBuffer(state, id);
      return Boolean(buffer && isFilesTextBuffer(buffer) && isFilesBufferDirty(buffer));
    });
    if (pending.length === 0) {
      return;
    }
    saveAllQueueRef.current = pending;
    await processSaveAllQueue();
  }, [processSaveAllQueue, store]);

  const resumeSaveAll = useCallback(async () => {
    if (!saveAllQueueRef.current) {
      return;
    }
    await processSaveAllQueue();
  }, [processSaveAllQueue]);

  const stopSaveAll = useCallback(() => {
    saveAllQueueRef.current = undefined;
  }, []);

  return {
    saveActiveFile,
    saveBufferById,
    saveActiveFileAs,
    saveAllFiles,
    resumeSaveAll,
    stopSaveAll,
  };
}
