import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  filesWorkspaceKey,
  findFilesBuffer,
  isFilesBufferDirty,
} from "@/files-workbench/filesEditorModel.js";
import {
  saveFilesTextBuffer,
  type FilesSaveBufferRequestOptions,
} from "@/files-workbench/filesEditorSaveIO.js";
import {
  resolveFilesCloseAfterDiscard,
  resolveFilesCloseAfterSave,
} from "@/files-workbench/filesEditorCloseAfterSave.js";
import { isFilesTextReadMissingError } from "@/files-workbench/filesEditorTextReader.js";
import { reloadFilesBufferFromDisk } from "@/files-workbench/filesEditorDiskReload.js";
import { writeFilesEditorSession } from "@/files-workbench/filesEditorPersistence.js";
import { disposeFilesMonacoModel } from "@/files-workbench/filesMonacoModels.js";
import { findFilesEditorView } from "@/files-workbench/filesEditorLayout.js";
import { useFilesEditorCloseActions } from "@/files-workbench/useFilesEditorCloseActions.js";
import { useFilesEditorDiskSync } from "@/files-workbench/useFilesEditorDiskSync.js";
import { useFilesEditorFileConflicts } from "@/files-workbench/useFilesEditorFileConflicts.js";
import { useFilesLargeTextDraftPersistence } from "@/files-workbench/useFilesLargeTextDraftPersistence.js";
import { filesLargeTextDraftOwner } from "@/files-workbench/filesLargeTextDraftStorage.js";
import { useFilesWorkbenchOpen } from "@/files-workbench/useFilesWorkbenchOpen.js";
import { useFilesEditorSaveActions } from "@/files-workbench/useFilesEditorSaveActions.js";
import { useFilesEditorRestore } from "@/files-workbench/useFilesEditorRestore.js";
import { useFilesLargeTextReopen } from "@/files-workbench/useFilesLargeTextReopen.js";
import { resolveFilesWorkspaceServices } from "@/files-workbench/filesWorkspaceFileService.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";
import type {
  FilesBuffer,
  FilesDirtyCloseDecision,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export type { FilesSaveConflictState } from "@/files-workbench/useFilesEditorFileConflicts.js";
export type SaveBufferOptions = FilesSaveBufferRequestOptions;

export function useFilesWorkbenchController(hasEnteredFiles: boolean, isActiveView: boolean) {
  // 持久化 owner 在首次进入文件工作台后持续运行；watch 只随可见状态启停。
  const restoreEnabled = hasEnteredFiles;
  const store = useFilesEditorStoreApi();
  const baseServices = useBaseWorkspaceServices();
  const { intl } = useZCodeIntl();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const workspaceTabs = useTabStore(useShallow((state) => state.tabs.filter(isWorkspaceTab)));
  const pendingOpen = useFilesEditorStore((state) => state.pendingOpen);
  const [saveAsBufferId, setSaveAsBufferId] = useState<string | undefined>();
  const [dirtyCloseBufferId, setDirtyCloseBufferId] = useState<string | undefined>();
  const savingIdsRef = useRef(new Set<string>());
  const reloadSeqRef = useRef(new Map<string, number>());
  const saveTextBufferRef = useRef<
    ((buffer: FilesBuffer, options?: SaveBufferOptions) => Promise<boolean>) | undefined
  >(undefined);
  const resumeAfterResolvedSaveRef = useRef<() => void>(() => undefined);
  const stopAfterFailedSaveRef = useRef<() => void>(() => undefined);

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

  /**
   * 大文件块补丁草稿的持久化 owner 接线。
   *
   * enabled 只跟随 restoreEnabled，不跟文件界面可见性：界面切走时仍要继续记录草稿。
   * probe 用当前磁盘版本 / 总字节做恢复拦截，版本不一致只 blocked，不改编辑基准。
   */
  const largeTextDrafts = useFilesLargeTextDraftPersistence({
    store,
    enabled: restoreEnabled,
    probeFile: async (buffer) => {
      try {
        const window = await resolveServices(buffer.workspace).fileService.readTextFileWindow({
          path: buffer.path,
          offset: 0,
          length: 4,
        });
        if (window.isBinary) return { kind: "binary" };
        return { kind: "present", version: window.version, totalBytes: window.totalBytes };
      } catch (error) {
        return isFilesTextReadMissingError(error) ? { kind: "missing" } : { kind: "failed" };
      }
    },
  });
  const discardLargeTextDraft = useCallback(
    async (bufferId: string) => {
      await largeTextDrafts.discardBlockedDraft(bufferId);
      await largeTextDrafts.flush();
    },
    [largeTextDrafts],
  );

  const isBufferSaving = useCallback((bufferId: string) => savingIdsRef.current.has(bufferId), []);

  const { loadRestoredTextFile, isRestoreLoadTracked } = useFilesEditorRestore({
    store,
    restoreEnabled,
    persist,
    resolveServices,
  });

  const reopenLargeTextFile = useFilesLargeTextReopen({
    store,
    persist,
    resolveServices,
  });

  const openExistingPath = useFilesWorkbenchOpen({
    store,
    persist,
    resolveServices,
    loadRestoredTextFile,
    isRestoreLoadTracked,
    reopenLargeTextFile,
  });

  /**
   * 用磁盘内容替换缓冲（冲突重载 / 外部变化重载 / 用户显式放弃草稿）。
   *
   * `allowDirty=false` 时读取完成后如果出现新输入就放弃提交，避免自动重载
   * 清掉用户刚输入的正文。所有分支共用同一份完整读取决策。
   */
  const reloadBufferFromDisk = useCallback(
    async (bufferId: string, options?: { allowDirty?: boolean }): Promise<boolean> => {
      const buffer = findFilesBuffer(store.getState(), bufferId);
      if (!buffer || !buffer.path) return false;
      const sequence = (reloadSeqRef.current.get(bufferId) ?? 0) + 1;
      reloadSeqRef.current.set(bufferId, sequence);
      return reloadFilesBufferFromDisk({
        store,
        bufferId,
        allowDirty: options?.allowDirty,
        fileService: resolveServices(buffer.workspace).fileService,
        isCurrentRequest: () => reloadSeqRef.current.get(bufferId) === sequence,
        persist,
      });
    },
    [persist, resolveServices, store],
  );

  const {
    conflictBuffer,
    largeConflictBuffer,
    reloadConfirmBufferId,
    showConflict,
    requestReloadBuffer,
    dismissExternalChange,
    handleConflictDecision,
    handleLargeConflictDecision,
    handleExternalReloadDecision,
  } = useFilesEditorFileConflicts({
    store,
    saveTextBufferRef,
    resumeAfterResolvedSaveRef,
    stopAfterFailedSaveRef,
    reloadBufferFromDisk,
    discardLargeTextDraft,
  });

  const saveTextBuffer = useCallback(
    async (buffer: FilesBuffer, options?: SaveBufferOptions) => {
      if (buffer.kind === "preview") return false;
      if (savingIdsRef.current.has(buffer.id)) {
        toast(intl.formatMessage({ id: "workspaceFileTree.actions.busy" }), {
          variant: "warning",
        });
        return false;
      }
      const path = options?.path ?? buffer.path;
      if (!path) {
        setSaveAsBufferId(buffer.id);
        return false;
      }
      savingIdsRef.current.add(buffer.id);
      try {
        return await saveFilesTextBuffer({
          store,
          buffer,
          path,
          force: options?.force,
          observedVersion: options?.observedVersion,
          targetVersion: options?.targetVersion,
          recreate: options?.recreate,
          fileService: resolveServices(buffer.workspace).fileService,
          onConflict: showConflict,
          onSaveFailed: (failedPath) =>
            toast(intl.formatMessage({ id: "filesWorkbench.saveFailed" }, { path: failedPath }), {
              variant: "warning",
            }),
          onBusy: () =>
            toast(intl.formatMessage({ id: "workspaceFileTree.actions.busy" }), {
              variant: "warning",
            }),
          onSaved: ({ path: savedPath, previousPath }) => {
            if (savedPath !== previousPath) {
              disposeFilesMonacoModel(buffer.id);
              // SaveAs 已提交成功：按旧 workspace/path owner 精确清理草稿，
              // API 会等待旧 key 的在途写入并保护仍被其他打开缓冲持有的 identity。
              if (buffer.kind === "large-text") {
                void largeTextDrafts.discardCommittedDraft(
                  filesLargeTextDraftOwner(buffer, previousPath ?? buffer.path),
                );
              }
            }
            persist();
          },
        });
      } finally {
        savingIdsRef.current.delete(buffer.id);
      }
    },
    [intl, largeTextDrafts, persist, resolveServices, showConflict, store],
  );

  const closeBuffer = useCallback(
    async (id: string, decision?: FilesDirtyCloseDecision) => {
      const buffer = findFilesBuffer(store.getState(), id);
      if (!buffer) {
        return;
      }
      // 保存中的 buffer 不能因当前瞬间看起来 clean 而关闭；大文件 token 是 Store
      // 的跨分屏租约，普通文本则由 controller 的 saving 集合保护关闭动作。
      if (savingIdsRef.current.has(id) || (buffer.kind === "large-text" && buffer.saveToken)) {
        return;
      }
      const closeSnapshot = {
        bufferRef: buffer,
        id: buffer.id,
        path: buffer.path,
        kind: buffer.kind,
        text: buffer.kind === "text" ? buffer.text : undefined,
        savedText: buffer.kind === "text" ? buffer.savedText : undefined,
        diskVersion: buffer.kind === "text" ? buffer.diskVersion : undefined,
        revision: buffer.kind === "large-text" ? buffer.edit?.revision : undefined,
        baseVersion: buffer.kind === "large-text" ? buffer.edit?.baseVersion : undefined,
        baseTotalBytes: buffer.kind === "large-text" ? buffer.edit?.baseTotalBytes : undefined,
        workspaceKey: filesWorkspaceKey(buffer.workspace),
      };
      if (isFilesBufferDirty(buffer) && decision !== "discard" && decision !== "save") {
        setDirtyCloseBufferId(id);
        return;
      }
      if (decision === "save") {
        const saved = await saveTextBuffer(buffer);
        if (!saved) return;
        const afterSave = resolveFilesCloseAfterSave(store.getState().buffers, id);
        if (afterSave !== "close") {
          if (afterSave === "prompt") setDirtyCloseBufferId(id);
          return;
        }
      }
      // discardLargeTextDraft 会 await IndexedDB；保存 token 持有者不能让后台
      // 删除持久化后再关闭，所以只对未进入保存的 large 草稿执行清理。
      if (decision === "discard" && buffer.kind === "large-text") {
        await discardLargeTextDraft(id);
      }
      const latest = findFilesBuffer(store.getState(), id);
      if (savingIdsRef.current.has(id)) return;
      if (decision === "discard") {
        if (resolveFilesCloseAfterDiscard(latest ? [latest] : [], closeSnapshot) !== "close") {
          if (latest && isFilesBufferDirty(latest)) setDirtyCloseBufferId(id);
          return;
        }
      } else if (
        !latest ||
        latest.kind !== closeSnapshot.kind ||
        latest.path !== closeSnapshot.path ||
        filesWorkspaceKey(latest.workspace) !== closeSnapshot.workspaceKey ||
        isFilesBufferDirty(latest) ||
        (latest.kind === "large-text" && latest.saveToken)
      ) {
        if (latest && isFilesBufferDirty(latest)) setDirtyCloseBufferId(id);
        return;
      }
      // 对所有 Store 关闭入口共同保护：异步存储清理前再出现保存 token 时，
      // closeBufferInState 会拒绝删除 owner；只有确认真的移除后才释放编辑器模型。
      store.getState().closeBuffer(id);
      if (findFilesBuffer(store.getState(), id)) return;
      disposeFilesMonacoModel(id);
      persist();
    },
    [discardLargeTextDraft, persist, saveTextBuffer, store],
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

  useFilesEditorDiskSync({
    store,
    enabled: restoreEnabled && (isActiveView ?? true),
    isSavingBuffer: isBufferSaving,
    resolveServices,
    onAutoReload: reloadBufferFromDisk,
  });

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

  const resumeAfterResolvedSave = useCallback(() => {
    resumePendingClose();
    void resumeSaveAll();
  }, [resumePendingClose, resumeSaveAll]);

  const stopAfterFailedSave = useCallback(() => {
    cancelPendingClose();
    stopSaveAll();
  }, [cancelPendingClose, stopSaveAll]);

  // 冲突 hook 通过 ref 调用稍后定义的保存 / 续接动作，避免声明顺序循环。
  saveTextBufferRef.current = saveTextBuffer;
  resumeAfterResolvedSaveRef.current = resumeAfterResolvedSave;
  stopAfterFailedSaveRef.current = stopAfterFailedSave;

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
    largeConflictBuffer,
    reloadConfirmBufferId,
    resolveServices,
    openExistingPath,
    loadRestoredTextFile,
    saveTextBuffer,
    reloadBufferFromDisk,
    requestReloadBuffer,
    largeTextDrafts,
    dismissExternalChange,
    isBufferSaving,
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
    handleLargeConflictDecision,
    handleExternalReloadDecision,
    handleDirtyCloseDecision,
  };
}
