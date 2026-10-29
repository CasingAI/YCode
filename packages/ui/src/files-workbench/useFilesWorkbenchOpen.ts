import { useCallback } from "react";
import { logger } from "@/logger.js";
import { resolveFilesBufferKind } from "@/files-workbench/filesEditorKind.js";
import {
  createPreviewBuffer,
  findFilesBuffer,
  findFilesFileBuffer,
  isFilesBufferDirty,
  isFilesLargeTextBuffer,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { readFilesTextForOpen } from "@/files-workbench/filesEditorTextReader.js";
import { disposeFilesMonacoModel } from "@/files-workbench/filesMonacoModels.js";
import {
  commitFilesEditorTextReadResult,
  readCurrentFilesEditorPath,
} from "@/files-workbench/filesEditorFileIO.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { IServiceAccessor } from "@zcode/services";
import type {
  FilesBuffer,
  FilesOpenMode,
  FilesPendingOpen,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

/** 打开 / 重新打开路径的读取决策与布局提交。 */
export function useFilesWorkbenchOpen(options: {
  store: FilesEditorStore;
  persist: () => void;
  resolveServices: (workspace: FilesWorkspaceRef) => IServiceAccessor;
  loadRestoredTextFile: (id: string) => Promise<void>;
  isRestoreLoadTracked: (id: string) => boolean;
  reopenLargeTextFile: (
    workspace: FilesWorkspaceRef,
    path: string,
    buffer: FilesBuffer,
    request?: FilesPendingOpen,
  ) => Promise<void>;
}) {
  const { store, persist, resolveServices } = options;

  return useCallback(
    async (
      workspace: FilesWorkspaceRef,
      path: string,
      mode: FilesOpenMode = "keep",
      request?: FilesPendingOpen,
    ) => {
      if (request && store.getState().pendingOpenInFlight !== request) return;
      const previousOpenIds = store.getState().openIds;
      const existing = findFilesFileBuffer(store.getState(), workspace, path);
      if (existing) {
        // 内存里的干净文本缓冲可能来自旧版本错误的元数据；重开时按当前共用分类纠正。
        // 脏草稿绝不转换：未保存正文优先于路径推断。
        if (
          isFilesTextBuffer(existing) &&
          existing.path &&
          !isFilesBufferDirty(existing) &&
          resolveFilesBufferKind(existing.path) === "preview"
        ) {
          store.getState().convertTextBufferToPreview(existing.id);
          disposeFilesMonacoModel(existing.id);
        }
        const current = findFilesBuffer(store.getState(), existing.id) ?? existing;
        store.getState().openBuffer(current, mode);
        persist();
        if (isFilesLargeTextBuffer(current)) {
          // 外部文件可能已缩小或变二进制；文件树再次打开时显式重新决策。
          // 必须等读取提交后再返回：调用方随即 completePendingOpen，提前结束会让
          // readCurrentFilesEditorPath 把本次结果判为过期而丢弃。
          await options.reopenLargeTextFile(workspace, path, current, request);
          return;
        }
        if (isFilesTextBuffer(current)) {
          const latest = findFilesBuffer(store.getState(), existing.id);
          if (
            latest &&
            isFilesTextBuffer(latest) &&
            (latest.loadState === "unloaded" ||
              latest.loadState === "error" ||
              (latest.loadState === "loading" && !options.isRestoreLoadTracked(latest.id)))
          ) {
            // A tab can be re-opened while its restored buffer is still empty.
            // Never leave a stale `loading` flag blocking retries after competing opens.
            if (latest.loadState === "loading") {
              store.getState().setTextLoadState(latest.id, "unloaded");
            }
            void options.loadRestoredTextFile(latest.id);
          }
        }
        return;
      }
      const kind = resolveFilesBufferKind(path);
      if (kind === "preview") {
        store.getState().openBuffer(createPreviewBuffer({ workspace, path }), mode);
      } else {
        try {
          const result = await readCurrentFilesEditorPath({
            store,
            workspace,
            path,
            request,
            // 打开与恢复共用同一读取决策：二进制转预览、≤ 8 MiB 完整读取可编辑、
            // > 8 MiB 建立大文本缓冲，不在这里另判阈值。
            read: () => readFilesTextForOpen(resolveServices(workspace).fileService, path),
            accept: (readResult) =>
              commitFilesEditorTextReadResult({
                store,
                workspace,
                path,
                result: readResult,
                mode,
              }),
          });
          if (result === null) return;
        } catch (error) {
          logger.warn("[files-workbench] 打开文件失败", { path, error });
          return;
        }
      }
      const nextOpenIds = new Set(store.getState().openIds);
      for (const id of previousOpenIds) {
        if (!nextOpenIds.has(id)) {
          disposeFilesMonacoModel(id);
        }
      }
      persist();
    },
    [options, persist, resolveServices, store],
  );
}
