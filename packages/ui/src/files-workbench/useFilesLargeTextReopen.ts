import { useCallback, useRef } from "react";
import type { FileTextWindow } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  filesWorkspaceKey,
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesLargeTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { readFilesTextForOpen } from "@/files-workbench/filesEditorTextReader.js";
import {
  filesLargeTextWindowOwner,
  seedFilesLargeTextWindowFromBuffer,
} from "@/files-workbench/filesLargeTextWindowSeed.js";
import { disposeFilesLargeTextWindow } from "@/files-workbench/filesLargeTextWindowStore.js";
import { readCurrentFilesEditorPath } from "@/files-workbench/filesEditorFileIO.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type {
  FilesBuffer,
  FilesLargeTextBuffer,
  FilesPendingOpen,
  FilesRetainedLargeTextDraftLookup,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

interface FilesLargeTextReopenOptions {
  store: FilesEditorStore;
  persist: () => void;
  /** 仍有索引库块补丁草稿时保持固定块模型，不能把草稿变成孤儿记录。 */
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
}

/**
 * 已打开的 large 标签被文件树再次显式打开时重新做一次读取决策。
 * 外部文件可能已缩小或变成二进制，不能一直粘在只读视图；只由打开动作触发，
 * 并对同一缓冲的在途读取去重，旧序号结果由 readCurrentFilesEditorPath 与 seq 双重拦截。
 */
export function useFilesLargeTextReopen(options: FilesLargeTextReopenOptions) {
  const { store, persist, resolveServices } = options;
  /** 显式重开 large 标签的去重与 stale 序号；只由打开动作触发，不随 render 循环。 */
  const loadsRef = useRef(new Map<string, { target: FilesBuffer; promise: Promise<void> }>());
  const seqRef = useRef(new Map<string, number>());

  return useCallback(
    (
      workspace: FilesWorkspaceRef,
      path: string,
      target: FilesBuffer,
      request?: FilesPendingOpen,
    ): Promise<void> => {
      // 已有未保存块修改时，显式「重新打开」只聚焦，不能重新接受磁盘内容：
      // 重读会以新首窗/新版本重建窗口，让旧补丁失去基准甚至静默丢弃草稿。
      // 冲突提示与放弃并重载由保存 / 冲突流程负责，这里不产生第二条写路径。
      const current = findFilesBuffer(store.getState(), target.id);
      if (current && isFilesLargeTextBuffer(current) && isFilesBufferDirty(current)) {
        store.getState().setActiveId(current.id);
        logger.info("[files-workbench] 大文件有未保存块修改，重开只聚焦不重读", { path });
        return Promise.resolve();
      }
      const pending = loadsRef.current.get(target.id);
      if (pending && pending.target === target) {
        return pending.promise;
      }
      const seq = (seqRef.current.get(target.id) ?? 0) + 1;
      seqRef.current.set(target.id, seq);
      const remoteSessionId = workspace.workspaceRemoteSessionId?.trim() ?? "";
      const operation = readCurrentFilesEditorPath({
        store,
        workspace,
        path,
        request,
        // 新一次显式重开会推进 seq：旧读取立即停止调度后续窗口，只做结果丢弃不够。
        read: ({ isCancelled }) =>
          readFilesTextForOpen(resolveServices(workspace).fileService, path, {
            isCancelled: () => isCancelled() || seqRef.current.get(target.id) !== seq,
          }),
        accept: async (result) => {
          if (seqRef.current.get(target.id) !== seq) return;
          const latest = findFilesBuffer(store.getState(), target.id);
          if (
            !latest ||
            !isFilesLargeTextBuffer(latest) ||
            latest.path !== path ||
            filesWorkspaceKey(latest.workspace) !== filesWorkspaceKey(workspace) ||
            (latest.workspace.workspaceRemoteSessionId?.trim() ?? "") !== remoteSessionId
          ) {
            return;
          }
          if (result.mode === "binary") {
            store.getState().convertTextBufferToPreview(latest.id);
          } else if (result.mode === "editable" || result.mode === "too-large") {
            const retained = options.loadRetainedLargeTextDraft
              ? await options.loadRetainedLargeTextDraft(latest)
              : ({ kind: "missing" } as const);
            if (seqRef.current.get(target.id) !== seq) return;
            const current = findFilesBuffer(store.getState(), latest.id);
            // 第二个 await 之后重新校验完整身份，避免改名 / 换工作区 / 换远程会话后误套旧结果。
            if (
              !current ||
              !isFilesLargeTextBuffer(current) ||
              current.path !== path ||
              filesWorkspaceKey(current.workspace) !== filesWorkspaceKey(workspace) ||
              (current.workspace.workspaceRemoteSessionId?.trim() ?? "") !== remoteSessionId
            ) {
              return;
            }
            if (retained.kind === "error") {
              // 读取失败不能当成没有草稿；保留固定块标签，用户可再次重开重试。
              logger.warn("[files-workbench] 重新打开大文件时读取保留草稿失败", {
                path,
                error: retained.error,
              });
              return;
            }
            if (retained.kind === "ready") {
              store.getState().setLargeTextTotalBytes(current.id, retained.baseTotalBytes);
              store
                .getState()
                .initializeLargeTextEdit(current.id, retained.baseVersion, retained.baseTotalBytes);
              persist();
              return;
            }
            if (result.mode === "too-large") {
              store.getState().completeLargeTextAsText(current.id, { text: "" });
              store.getState().setTextLoadState(current.id, "error", "too-large");
              persist();
              return;
            }
            store.getState().completeLargeTextAsText(current.id, { text: result.text });
            store.getState().markSaved(current.id, {
              path,
              text: result.text,
              workspace: current.workspace,
              version: result.version,
            });
          } else {
            store.getState().setLargeTextTotalBytes(latest.id, result.totalBytes, result.reason);
            store.getState().initializeLargeTextEdit(latest.id, result.version, result.totalBytes);
            const large = findFilesBuffer(store.getState(), latest.id);
            if (large && isFilesLargeTextBuffer(large)) {
              // 用户显式重开接受磁盘上的新版本：先失效同 owner 的旧窗口与在途请求，
              // 再交付新首窗。refCount > 0 时 dispose 会保留 entry、lease 与订阅，
              // 因此同一微任务内 seed 后，已挂载的 viewer 直接收到新窗口而不重读。
              disposeFilesLargeTextWindow(large.id, filesLargeTextWindowOwner(large));
              seedFilesLargeTextWindowFromBuffer(large, result.firstWindow);
            }
          }
          persist();
        },
        reject: (error) => {
          logger.warn("[files-workbench] 重新打开大文件失败", { path, error });
        },
      });
      let tracked: Promise<void>;
      tracked = operation
        .then(() => undefined)
        .finally(() => {
          if (loadsRef.current.get(target.id)?.promise === tracked) {
            loadsRef.current.delete(target.id);
            seqRef.current.delete(target.id);
          }
        });
      loadsRef.current.set(target.id, { target, promise: tracked });
      return tracked;
    },
    [persist, resolveServices, store],
  );
}
