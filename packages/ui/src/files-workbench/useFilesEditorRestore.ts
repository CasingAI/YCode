import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { FileTextWindow } from "@zcode/shared";
import { logger } from "@/logger.js";
import { filesWorkspaceKey } from "@/files-workbench/filesEditorBufferModel.js";
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
import type {
  FilesBuffer,
  FilesLargeTextBuffer,
  FilesPersistedSession,
  FilesRetainedLargeTextDraftLookup,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

/** 恢复等待 IndexedDB 后，缓冲仍必须属于同一路径 / 工作区身份 / 远程会话。 */
function sameFilesRestoreTarget(
  buffer: FilesLargeTextBuffer,
  workspace: FilesWorkspaceRef,
  path: string,
): boolean {
  return (
    buffer.path === path &&
    filesWorkspaceKey(buffer.workspace) === filesWorkspaceKey(workspace) &&
    (buffer.workspace.workspaceRemoteSessionId?.trim() ?? "") ===
      (workspace.workspaceRemoteSessionId?.trim() ?? "")
  );
}

/**
 * 冷启动会话水合。
 *
 * localStorage 是同步基线，完整文本大草稿还要等 IndexedDB；等待期间用户可能
 * 已经打开文件或输入。此时以运行态为准，跳过整体水合，绝不用旧会话覆盖新工作。
 */
export async function hydrateFilesEditorSession(options: {
  store: FilesEditorStore;
  loadSession?: () => Promise<FilesPersistedSession | undefined>;
  persist: () => void;
  isCancelled?: () => boolean;
}): Promise<boolean> {
  let session: FilesPersistedSession | undefined;
  try {
    session = options.loadSession ? await options.loadSession() : readFilesEditorSession();
  } catch (error) {
    logger.warn("[files-workbench] 读取文件会话失败", { error });
    session = readFilesEditorSession();
  }
  if (options.isCancelled?.() || !session) {
    return false;
  }
  const current = options.store.getState();
  if (current.buffers.length > 0 || current.openIds.length > 0) {
    // hydrateSession 会整体替换 buffers/openIds/layout；运行态已有内容时只能跳过。
    logger.info("[files-workbench] 会话读取期间已有运行态缓冲，保留运行态不水合", {
      buffers: current.buffers.length,
    });
    return false;
  }
  options.store.getState().hydrateSession(session);
  // Persist the normalized snapshot once so a corrupt legacy session self-heals.
  options.persist();
  return true;
}

/**
 * 恢复上次会话打开的文件。
 *
 * 隐藏的文件工作台只恢复可见标签，且串行加载（避免一次恢复几百个文件把主线程打满）。
 * 大文本标签只恢复元数据；首次激活时用同一读取决策按需读盘：
 * 磁盘已恢复为合法 UTF-8 则转为完整可编辑文本，非法 UTF-8 保持固定块，
 * 二进制转为预览，超过单字符串硬上限则显示明确错误。
 */

export function useFilesEditorRestore(options: {
  store: FilesEditorStore;
  restoreEnabled: boolean;
  persist: () => void;
  loadSession?: () => Promise<FilesPersistedSession | undefined>;
  /** 用于迁移旧 large-text 标签：仍有索引库补丁草稿时不得转成完整正文。 */
  loadRetainedLargeTextDraft?: (
    buffer: FilesLargeTextBuffer,
  ) => Promise<FilesRetainedLargeTextDraftLookup>;
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
  const loadSessionRef = useRef(options.loadSession);
  loadSessionRef.current = options.loadSession;
  const loadRetainedDraftRef = useRef(options.loadRetainedLargeTextDraft);
  loadRetainedDraftRef.current = options.loadRetainedLargeTextDraft;
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
          accept: async (result) => {
            const latest = findFilesBuffer(store.getState(), id);
            if (!latest) {
              return;
            }
            if (isFilesLargeTextBuffer(latest)) {
              if (result.mode === "binary") {
                store.getState().convertTextBufferToPreview(id);
              } else if (result.mode === "editable" || result.mode === "too-large") {
                // 迁移安全：索引库里仍有该路径的块补丁草稿时，保持固定块模型，
                // 让既有草稿恢复/冲突流程继续生效，不能把草稿变成孤儿记录。
                const retained = loadRetainedDraftRef.current
                  ? await loadRetainedDraftRef.current(latest)
                  : ({ kind: "missing" } as const);
                const stillCurrent = findFilesBuffer(store.getState(), id);
                // 等待 IndexedDB 期间可能已改名 / 换工作区 / 换远程会话，旧结果不能再落盘。
                if (
                  !stillCurrent ||
                  !isFilesLargeTextBuffer(stillCurrent) ||
                  !sameFilesRestoreTarget(stillCurrent, workspace, path)
                ) {
                  return;
                }
                if (retained.kind === "error") {
                  // 读不到保留草稿不能当成“没有草稿”转模型；保留旧标签并暴露可重试错误。
                  failFilesLargeTextWindowSeed(stillCurrent, retained.error, () =>
                    retryLargeRef.current(id),
                  );
                  return;
                }
                if (retained.kind === "ready") {
                  store.getState().setLargeTextTotalBytes(id, retained.baseTotalBytes);
                  store
                    .getState()
                    .initializeLargeTextEdit(id, retained.baseVersion, retained.baseTotalBytes);
                  return;
                }
                if (result.mode === "too-large") {
                  // 合法文本超过单字符串硬上限：不再有可用的块模型，显示明确错误。
                  store.getState().completeLargeTextAsText(id, { text: "" });
                  store.getState().setTextLoadState(id, "error", "too-large");
                  return;
                }
                store.getState().completeLargeTextAsText(id, { text: result.text });
                store.getState().markSaved(id, {
                  path,
                  text: result.text,
                  workspace,
                  version: result.version,
                });
              } else {
                // 仍为非法 UTF-8：补全元数据并建立编辑基准，viewer 不再重复读盘。
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
    let cancelled = false;
    void hydrateFilesEditorSession({
      store,
      loadSession: loadSessionRef.current,
      persist,
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [persist, restoreEnabled, store]);

  useEffect(() => {
    if (!restoreEnabled || !activeId) {
      return;
    }
    const buffer = findFilesBuffer(store.getState(), activeId);
    // 新打开的 large buffer 已带首窗 totalBytes，无需再判定；恢复的 large 只有元数据，
    // 首次激活时补一次读取决策，合法 UTF-8 转完整正文，非法字节保持固定块。
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
