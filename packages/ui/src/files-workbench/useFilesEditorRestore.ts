import { useCallback, useEffect, useRef } from "react";
import type { FileTextSlice } from "@zcode/shared";
import { FILE_VIEWER_MAX_TEXT_BYTES } from "@/lib/codeViewer.js";
import { logger } from "@/logger.js";
import { findFilesBuffer, isFilesTextBuffer } from "@/files-workbench/filesEditorModel.js";
import { readFilesEditorSession } from "@/files-workbench/filesEditorPersistence.js";
import { isFilesEditorBufferActiveInLayout } from "@/files-workbench/filesEditorStoreLayout.js";
import {
  commitFilesEditorReadResult,
  readCurrentFilesEditorPath,
} from "@/files-workbench/filesEditorFileIO.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

/**
 * 恢复上次会话打开的文件。
 *
 * 隐藏的文件工作台只恢复可见标签，且串行加载（避免一次恢复几百个文件把主线程打满）。
 */

export function useFilesEditorRestore(options: {
  store: FilesEditorStore;
  restoreEnabled: boolean;
  persist: () => void;
  resolveServices: (workspace: FilesWorkspaceRef) => {
    fileService: {
      readTextFile: (args: { path: string; length: number }) => Promise<FileTextSlice>;
    };
  };
}) {
  const { store, restoreEnabled, persist, resolveServices } = options;
  const restoredRef = useRef(false);
  const restoreQueueRef = useRef<Promise<void>>(Promise.resolve());
  const restoreLoadsRef = useRef(new Map<string, Promise<void>>());

  const loadRestoredTextFile = useCallback(
    (id: string): Promise<void> => {
      const existingRequest = restoreLoadsRef.current.get(id);
      if (existingRequest) {
        return existingRequest;
      }
      const buffer = findFilesBuffer(store.getState(), id);
      if (!buffer || !isFilesTextBuffer(buffer) || !buffer.path || !buffer.loadState) {
        return Promise.resolve();
      }

      // Hidden surfaces restore only visible tabs, serially, without rewriting the saved session.
      const request = restoreQueueRef.current.then(async () => {
        const current = findFilesBuffer(store.getState(), id);
        if (
          !current ||
          !isFilesTextBuffer(current) ||
          !current.path ||
          (current.loadState !== "unloaded" && current.loadState !== "error") ||
          !isFilesEditorBufferActiveInLayout(store.getState().layout, id)
        ) {
          return;
        }

        const path = current.path;
        store.getState().setTextLoadState(id, "loading");
        await readCurrentFilesEditorPath({
          store,
          workspace: current.workspace,
          path,
          read: () =>
            resolveServices(current.workspace).fileService.readTextFile({
              path,
              length: FILE_VIEWER_MAX_TEXT_BYTES,
            }),
          accept: (slice) => {
            // 未知扩展名只有读盘后才可能暴露为二进制；与原文本恢复共用提交路径，
            // 在同一 ID 内转为预览，避免先建立可保存的空文本缓冲。
            commitFilesEditorReadResult({
              store,
              workspace: current.workspace,
              path,
              result: slice,
              targetId: id,
            });
          },
          reject: (error) => {
            const latest = findFilesBuffer(store.getState(), id);
            if (latest && isFilesTextBuffer(latest) && latest.loadState === "loading") {
              store.getState().setTextLoadState(id, "error");
            }
            logger.warn("[files-workbench] 恢复文件失败", { path: current.path, error });
          },
        });
      });

      let trackedRequest: Promise<void>;
      trackedRequest = request.then(
        () => {
          if (restoreLoadsRef.current.get(id) === trackedRequest) {
            restoreLoadsRef.current.delete(id);
            const latest = findFilesBuffer(store.getState(), id);
            // A→B→A 会复用 ID；旧读取失效后要继续当前未加载缓冲，不能被旧 Promise 挡住。
            if (
              latest &&
              isFilesTextBuffer(latest) &&
              latest.loadState === "unloaded" &&
              isFilesEditorBufferActiveInLayout(store.getState().layout, id)
            ) {
              void loadRestoredTextFile(id);
            }
          }
        },
        (error: unknown) => {
          if (restoreLoadsRef.current.get(id) === trackedRequest) {
            restoreLoadsRef.current.delete(id);
          }
          logger.warn("[files-workbench] 恢复文件失败", { id, error });
        },
      );
      restoreLoadsRef.current.set(id, trackedRequest);
      restoreQueueRef.current = trackedRequest;
      return trackedRequest;
    },
    [resolveServices, store],
  );

  useEffect(() => {
    if (!restoreEnabled || restoredRef.current) {
      return;
    }
    restoredRef.current = true;
    const session = readFilesEditorSession();
    if (!session) {
      return;
    }
    store.getState().hydrateSession(session);
    // Persist the normalized snapshot once so a corrupt legacy session self-heals.
    persist();
  }, [persist, restoreEnabled, store]);

  return {
    loadRestoredTextFile,
    /** 该文件是否仍有恢复加载在途（打开已有文件时用它判断能否重新加载）。 */
    isRestoreLoadTracked: (id: string) => restoreLoadsRef.current.has(id),
  };
}
