import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { FileTextWindow } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  findFilesBuffer,
  isFilesLargeTextBuffer,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { readFilesEditorSession } from "@/files-workbench/filesEditorPersistence.js";
import { isFilesEditorBufferActiveInLayout } from "@/files-workbench/filesEditorStoreLayout.js";
import {
  commitFilesEditorTextReadResult,
  readCurrentFilesEditorPath,
} from "@/files-workbench/filesEditorFileIO.js";
import { readFilesTextForOpen } from "@/files-workbench/filesEditorTextReader.js";
import {
  failFilesLargeTextWindowSeed,
  seedFilesLargeTextWindowFromBuffer,
} from "@/files-workbench/filesLargeTextWindowSeed.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { FilesBuffer, FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

/**
 * 恢复上次会话打开的文件。
 *
 * 隐藏的文件工作台只恢复可见标签，且串行加载（避免一次恢复几百个文件把主线程打满）。
 * 大文本标签只恢复元数据；首次激活时用同一读取决策按需读盘：
 * 磁盘仍 > 8 MiB 保持只读窗口，回到 ≤ 8 MiB 转为完整可编辑文本，二进制转为预览。
 */

export function useFilesEditorRestore(options: {
  store: FilesEditorStore;
  restoreEnabled: boolean;
  persist: () => void;
  resolveServices: (workspace: FilesWorkspaceRef) => {
    fileService: {
      readTextFileWindow: (args: {
        path: string;
        offset?: number;
        length?: number;
        expectedVersion?: string;
      }) => Promise<FileTextWindow>;
    };
  };
}) {
  const { store, restoreEnabled, persist, resolveServices } = options;
  const restoredRef = useRef(false);
  const restoreQueueRef = useRef<Promise<void>>(Promise.resolve());
  const restoreLoadsRef = useRef(new Map<string, Promise<void>>());
  /** viewer 的 retry/refresh 通过它回到统一恢复 loader，而不是直接按窗口读取。 */
  const retryLargeRef = useRef<(id: string) => void>(() => undefined);
  const subscribeActiveId = useCallback(
    (onChange: () => void) => store.subscribe(onChange),
    [store],
  );
  const getActiveId = useCallback(() => store.getState().activeId, [store]);
  const activeId = useSyncExternalStore(subscribeActiveId, getActiveId, getActiveId);

  const isLoadableBuffer = useCallback((buffer: FilesBuffer | undefined): boolean => {
    if (!buffer || !buffer.path) {
      return false;
    }
    if (isFilesLargeTextBuffer(buffer)) {
      // totalBytes 只在 core 完成首次读取决策后写入；写入后不再重复恢复读取。
      return buffer.totalBytes === undefined;
    }
    return (
      isFilesTextBuffer(buffer) && (buffer.loadState === "unloaded" || buffer.loadState === "error")
    );
  }, []);

  const loadRestoredTextFile = useCallback(
    (id: string): Promise<void> => {
      const existingRequest = restoreLoadsRef.current.get(id);
      if (existingRequest) {
        return existingRequest;
      }
      const buffer = findFilesBuffer(store.getState(), id);
      if (!isLoadableBuffer(buffer) || !buffer?.path) {
        return Promise.resolve();
      }

      // Hidden surfaces restore only visible tabs, serially, without rewriting the saved session.
      const request = restoreQueueRef.current.then(async () => {
        const current = findFilesBuffer(store.getState(), id);
        if (
          !isLoadableBuffer(current) ||
          !current?.path ||
          !isFilesEditorBufferActiveInLayout(store.getState().layout, id)
        ) {
          return;
        }

        const path = current.path;
        const isLargeTarget = isFilesLargeTextBuffer(current);
        if (!isLargeTarget) {
          store.getState().setTextLoadState(id, "loading");
        }
        const workspace = current.workspace;
        await readCurrentFilesEditorPath({
          store,
          workspace,
          path,
          read: () => readFilesTextForOpen(resolveServices(workspace).fileService, path),
          accept: (result) => {
            const latest = findFilesBuffer(store.getState(), id);
            if (!latest) {
              return;
            }
            // 大文本恢复决策：二进制转预览、回到阈值内转完整文本、仍大则保持只读。
            if (isFilesLargeTextBuffer(latest)) {
              if (result.mode === "binary") {
                store.getState().convertTextBufferToPreview(id);
              } else if (result.mode === "editable") {
                store.getState().completeLargeTextAsText(id, { text: result.text });
                store.getState().markSaved(id, {
                  path,
                  text: result.text,
                  workspace,
                  version: result.version,
                });
              } else {
                // 仍是大文本：补全元数据并建立编辑基准，viewer 不再重复读盘。
                store.getState().setLargeTextTotalBytes(id, result.totalBytes, result.reason);
                store.getState().initializeLargeTextEdit(id, result.version, result.totalBytes);
                const large = findFilesBuffer(store.getState(), id);
                if (large && isFilesLargeTextBuffer(large)) {
                  seedFilesLargeTextWindowFromBuffer(large, result.firstWindow);
                }
              }
              return;
            }
            commitFilesEditorTextReadResult({
              store,
              workspace,
              path,
              result,
              targetId: id,
            });
          },
          reject: (error) => {
            const latest = findFilesBuffer(store.getState(), id);
            if (latest && isFilesLargeTextBuffer(latest)) {
              // 大文本首次决策失败时 totalBytes 仍未知，viewer 不会自行读盘；
              // 把错误与统一 loader 交给 rangeStore，避免标签一直停在 idle。
              failFilesLargeTextWindowSeed(latest, error, () => retryLargeRef.current(id));
            } else if (latest && isFilesTextBuffer(latest) && latest.loadState === "loading") {
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
            // A→B→A 会复用 ID；旧读取失效后要继续当前未加载文本缓冲，不能被旧 Promise 挡住。
            // 大文本失败不自动重试，避免离线时连续请求；rangeStore 已持有错误与统一重试入口。
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
    [isLoadableBuffer, resolveServices, store],
  );

  retryLargeRef.current = (id) => {
    void loadRestoredTextFile(id);
  };

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

  useEffect(() => {
    if (!restoreEnabled || !activeId) {
      return;
    }
    const buffer = findFilesBuffer(store.getState(), activeId);
    // 新打开的 large buffer 已带首窗 totalBytes，无需再判定；恢复的 large 只有元数据，
    // 首次激活时补一次读取决策，磁盘回到阈值内或变成二进制就转换。
    if (!buffer || !isFilesLargeTextBuffer(buffer) || buffer.totalBytes !== undefined) {
      return;
    }
    void loadRestoredTextFile(activeId);
  }, [activeId, loadRestoredTextFile, restoreEnabled, store]);

  return {
    loadRestoredTextFile,
    /** 该文件是否仍有恢复加载在途（打开已有文件时用它判断能否重新加载）。 */
    isRestoreLoadTracked: (id: string) => restoreLoadsRef.current.has(id),
  };
}
