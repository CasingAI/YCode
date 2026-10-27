import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { FILE_VIEWER_MAX_TEXT_BYTES } from "@/lib/codeViewer.js";
import { resolveFilesBufferKind } from "@/files-workbench/filesEditorKind.js";
import {
  createPreviewBuffer,
  detectFilesSaveConflict,
  findFilesBuffer,
  findFilesFileBuffer,
  isFilesBufferDirty,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { writeFilesEditorSession } from "@/files-workbench/filesEditorPersistence.js";
import { disposeFilesMonacoModel } from "@/files-workbench/filesMonacoModels.js";
import { findFilesEditorView } from "@/files-workbench/filesEditorLayout.js";
import { useFilesEditorCloseActions } from "@/files-workbench/useFilesEditorCloseActions.js";
import { useFilesEditorSaveActions } from "@/files-workbench/useFilesEditorSaveActions.js";
import { useFilesEditorRestore } from "@/files-workbench/useFilesEditorRestore.js";
import { resolveFilesWorkspaceServices } from "@/files-workbench/filesWorkspaceFileService.js";
import {
  commitFilesEditorReadResult,
  readCurrentFilesEditorPath,
  runFilesEditorFileOperation,
} from "@/files-workbench/filesEditorFileIO.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";
import type {
  FilesDirtyCloseDecision,
  FilesOpenMode,
  FilesPendingOpen,
  FilesSaveConflictDecision,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export function useFilesWorkbenchController(restoreEnabled: boolean) {
  const store = useFilesEditorStoreApi();
  const baseServices = useBaseWorkspaceServices();
  const { intl } = useZCodeIntl();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const workspaceTabs = useTabStore(useShallow((state) => state.tabs.filter(isWorkspaceTab)));
  const pendingOpen = useFilesEditorStore((state) => state.pendingOpen);
  const [saveAsBufferId, setSaveAsBufferId] = useState<string | undefined>();
  const [dirtyCloseBufferId, setDirtyCloseBufferId] = useState<string | undefined>();
  const [conflictBuffer, setConflictBuffer] = useState<FilesTextBuffer | undefined>();

  const resolveServices = useCallback(
    (workspace: FilesWorkspaceRef) =>
      resolveFilesWorkspaceServices({
        workspace,
        baseServices,
        sessionsById,
        workspaceTabs,
      }),
    [baseServices, sessionsById, workspaceTabs],
  );

  const persist = useCallback(() => {
    writeFilesEditorSession(store.getState().snapshotSession());
  }, [store]);

  const { loadRestoredTextFile, isRestoreLoadTracked } = useFilesEditorRestore({
    store,
    restoreEnabled,
    persist,
    resolveServices,
  });

  const openExistingPath = useCallback(
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
        if (isFilesTextBuffer(current)) {
          const latest = findFilesBuffer(store.getState(), existing.id);
          if (
            latest &&
            isFilesTextBuffer(latest) &&
            (latest.loadState === "unloaded" ||
              latest.loadState === "error" ||
              (latest.loadState === "loading" && !isRestoreLoadTracked(latest.id)))
          ) {
            // A tab can be re-opened while its restored buffer is still empty.
            // Never leave a stale `loading` flag blocking retries after competing opens.
            if (latest.loadState === "loading") {
              store.getState().setTextLoadState(latest.id, "unloaded");
            }
            void loadRestoredTextFile(latest.id);
          }
        }
        return;
      }
      const kind = resolveFilesBufferKind(path);
      if (kind === "preview") {
        store.getState().openBuffer(createPreviewBuffer({ workspace, path }), mode);
      } else {
        try {
          const slice = await readCurrentFilesEditorPath({
            store,
            workspace,
            path,
            request,
            read: () =>
              resolveServices(workspace).fileService.readTextFile({
                path,
                length: FILE_VIEWER_MAX_TEXT_BYTES,
              }),
            // 未知扩展名不能只凭路径当作文本：读取结果标为二进制时建立只读预览，
            // 不留下可保存的空文本缓冲。初次打开与恢复共用同一提交路径。
            accept: (result) =>
              commitFilesEditorReadResult({
                store,
                workspace,
                path,
                result,
                mode,
              }),
          });
          if (slice === null) return;
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
    [loadRestoredTextFile, persist, resolveServices, store],
  );

  const saveTextBuffer = useCallback(
    async (buffer: FilesTextBuffer, options?: { force?: boolean; path?: string }) => {
      const path = options?.path ?? buffer.path;
      if (!path) {
        setSaveAsBufferId(buffer.id);
        return false;
      }
      return runFilesEditorFileOperation(
        buffer.workspace,
        async () => {
          const current = findFilesBuffer(store.getState(), buffer.id);
          if (!current || !isFilesTextBuffer(current) || current.path !== buffer.path) return false;
          const fileService = resolveServices(buffer.workspace).fileService;
          let diskText: string | undefined;
          try {
            const slice = await fileService.readTextFile({
              path,
              length: FILE_VIEWER_MAX_TEXT_BYTES,
            });
            diskText = slice.content;
          } catch {
            diskText = undefined;
          }
          if (
            !options?.force &&
            detectFilesSaveConflict({
              currentText: buffer.text,
              savedText: buffer.savedText,
              diskText,
            }) === "conflict"
          ) {
            setConflictBuffer(buffer);
            return false;
          }
          try {
            await fileService.writeTextFile({ path, content: buffer.text });
          } catch (error) {
            // 写盘失败必须让用户看见：静默失败会表现为「按了保存但文件没变」。
            // 失败后不标记已保存，标签继续保持未保存态，关闭流程也不会继续。
            logger.error("[files-workbench] 保存文件失败", { path, error });
            toast(intl.formatMessage({ id: "filesWorkbench.saveFailed" }, { path }), {
              variant: "warning",
            });
            return false;
          }
          const latest = findFilesBuffer(store.getState(), buffer.id);
          if (!latest || !isFilesTextBuffer(latest) || latest.path !== buffer.path) return false;
          store.getState().markSaved(buffer.id, {
            path,
            text: buffer.text,
            workspace: buffer.workspace,
            preserveCurrentText: true,
          });
          if (path !== buffer.path) {
            disposeFilesMonacoModel(buffer.id);
          }
          persist();
          return true;
        },
        () =>
          toast(intl.formatMessage({ id: "workspaceFileTree.actions.busy" }), {
            variant: "warning",
          }),
      );
    },
    [intl, persist, resolveServices, store],
  );

  const closeBuffer = useCallback(
    async (id: string, decision?: FilesDirtyCloseDecision) => {
      const buffer = findFilesBuffer(store.getState(), id);
      if (!buffer) {
        return;
      }
      if (isFilesBufferDirty(buffer) && decision !== "discard" && decision !== "save") {
        setDirtyCloseBufferId(id);
        return;
      }
      if (decision === "save" && isFilesTextBuffer(buffer)) {
        const saved = await saveTextBuffer(buffer);
        if (!saved) {
          return;
        }
      }
      store.getState().closeBuffer(id);
      disposeFilesMonacoModel(id);
      persist();
    },
    [persist, saveTextBuffer, store],
  );

  const {
    closeView,
    closeOtherViews,
    closeViewsToRight,
    closeSavedViews,
    closeAllViews,
    resumePendingClose,
    cancelPendingClose,
  } = useFilesEditorCloseActions({
    store,
    persist,
    closeBuffer,
    onDirtyBuffer: setDirtyCloseBufferId,
  });

  /** 当前聚焦编辑器组的活动标签（VS Code 里 ⌘W 关的就是它）。 */
  const activeEditorView = useCallback(() => {
    const state = store.getState();
    const group = state.layout.groups[state.layout.focusedGroupId];
    const viewId = group?.activeViewId;
    if (!viewId) {
      return undefined;
    }
    const view = findFilesEditorView(state.layout, viewId);
    return view ? { viewId: view.id, bufferId: view.bufferId } : undefined;
  }, [store]);

  /**
   * 保存动作（保存 / 另存为 / 全部保存）集中在独立 hook：
   * 队列、暂停与续接规则只有一份实现，菜单、快捷键、标签栏按钮共用。
   */
  const {
    saveActiveFile,
    saveBufferById,
    saveActiveFileAs,
    saveBufferAs,
    saveAllFiles,
    resumeSaveAll,
    stopSaveAll,
  } = useFilesEditorSaveActions({ store, saveTextBuffer, setSaveAsBufferId });

  /** 关闭当前聚焦编辑器组的活动标签（macOS ⌘W 语义）。 */
  const closeActiveEditorView = useCallback(() => {
    const target = activeEditorView();
    if (!target) {
      return false;
    }
    void closeView(target.bufferId, target.viewId);
    return true;
  }, [activeEditorView, closeView]);

  useEffect(() => {
    if (!pendingOpen || !store.getState().beginPendingOpen(pendingOpen)) return;
    void (async () => {
      try {
        await openExistingPath(
          pendingOpen.workspace,
          pendingOpen.path,
          pendingOpen.preview === true ? "preview" : "keep",
          pendingOpen,
        );
      } finally {
        store.getState().completePendingOpen(pendingOpen);
      }
    })();
  }, [openExistingPath, pendingOpen, store]);

  const handleConflictDecision = useCallback(
    async (decision: FilesSaveConflictDecision | "cancel") => {
      const buffer = conflictBuffer;
      setConflictBuffer(undefined);
      if (!buffer) return;
      if (decision === "cancel") {
        cancelPendingClose();
        stopSaveAll();
        return;
      }
      let resolved = false;
      if (decision === "overwrite") {
        resolved = await saveTextBuffer(buffer, { force: true });
      } else if (buffer.path) {
        try {
          const slice = await resolveServices(buffer.workspace).fileService.readTextFile({
            path: buffer.path,
            length: FILE_VIEWER_MAX_TEXT_BYTES,
          });
          store.getState().updateText(buffer.id, slice.content);
          store.getState().markSaved(buffer.id, {
            path: buffer.path,
            text: slice.content,
            workspace: buffer.workspace,
          });
          persist();
          resolved = true;
        } catch (error) {
          logger.warn("[files-workbench] 冲突后重载失败", { path: buffer.path, error });
        }
      }
      if (!resolved) {
        // 保存失败：关闭流程与全部保存都就此停止，剩余文件保持未保存。
        // 待续接的关闭也一并取消——文件没能保存，关掉就等于丢内容。
        cancelPendingClose();
        stopSaveAll();
        return;
      }
      resumePendingClose();
      void resumeSaveAll();
    },
    [
      cancelPendingClose,
      conflictBuffer,
      persist,
      resolveServices,
      resumePendingClose,
      resumeSaveAll,
      saveTextBuffer,
      stopSaveAll,
      store,
    ],
  );

  const handleDirtyCloseDecision = useCallback(
    async (decision: FilesDirtyCloseDecision) => {
      const id = dirtyCloseBufferId;
      setDirtyCloseBufferId(undefined);
      if (!id) return;
      if (decision === "cancel") {
        cancelPendingClose();
        return;
      }
      await closeBuffer(id, decision);
      // Save may be deferred by a conflict or Save As dialog; resume only after it closes.
      if (!findFilesBuffer(store.getState(), id)) {
        resumePendingClose();
      }
    },
    [cancelPendingClose, closeBuffer, dirtyCloseBufferId, resumePendingClose, store],
  );

  return {
    saveAsBufferId,
    setSaveAsBufferId,
    dirtyCloseBufferId,
    conflictBuffer,
    resolveServices,
    openExistingPath,
    loadRestoredTextFile,
    saveTextBuffer,
    saveActiveFile,
    saveBufferById,
    saveActiveFileAs,
    saveBufferAs,
    saveAllFiles,
    resumeSaveAll,
    stopSaveAll,
    closeActiveEditorView,
    closeBuffer,
    closeView,
    closeOtherViews,
    closeViewsToRight,
    closeSavedViews,
    closeAllViews,
    resumePendingClose,
    cancelPendingClose,
    persist,
    handleConflictDecision,
    handleDirtyCloseDecision,
  };
}
