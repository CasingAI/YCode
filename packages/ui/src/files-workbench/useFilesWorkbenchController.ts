import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FILE_VIEWER_MAX_TEXT_BYTES } from "@/lib/codeViewer.js";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { resolveFilesBufferKind } from "@/files-workbench/filesEditorKind.js";
import {
  createPreviewBuffer,
  createTextFileBuffer,
  detectFilesSaveConflict,
  findFilesBuffer,
  findFilesFileBuffer,
  isFilesBufferDirty,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import {
  readFilesEditorSession,
  writeFilesEditorSession,
} from "@/files-workbench/filesEditorPersistence.js";
import { disposeFilesMonacoModel } from "@/files-workbench/filesMonacoModels.js";
import { isFilesEditorBufferActiveInLayout } from "@/files-workbench/filesEditorStoreLayout.js";
import { useFilesEditorCloseActions } from "@/files-workbench/useFilesEditorCloseActions.js";
import { findFilesEditorGroupForView } from "@/files-workbench/filesEditorLayout.js";
import { resolveFilesWorkspaceServices } from "@/files-workbench/filesWorkspaceFileService.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";
import type {
  FilesDirtyCloseDecision,
  FilesOpenMode,
  FilesSaveConflictDecision,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export function useFilesWorkbenchController(restoreEnabled: boolean) {
  const store = useFilesEditorStoreApi();
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const workspaceTabs = useTabStore(useShallow((state) => state.tabs.filter(isWorkspaceTab)));
  const pendingOpen = useFilesEditorStore((state) => state.pendingOpen);
  const [saveAsBufferId, setSaveAsBufferId] = useState<string | undefined>();
  const [dirtyCloseBufferId, setDirtyCloseBufferId] = useState<string | undefined>();
  const [conflictBuffer, setConflictBuffer] = useState<FilesTextBuffer | undefined>();
  const [pendingCloseGroupId, setPendingCloseGroupId] = useState<string | undefined>();
  const restoredRef = useRef(false);
  const restoreQueueRef = useRef<Promise<void>>(Promise.resolve());
  const restoreLoadsRef = useRef(new Map<string, Promise<void>>());

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

  const loadRestoredTextFile = useCallback(
    (id: string) => {
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

        store.getState().setTextLoadState(id, "loading");
        try {
          const slice = await resolveServices(current.workspace).fileService.readTextFile({
            path: current.path,
            length: FILE_VIEWER_MAX_TEXT_BYTES,
          });
          const latest = findFilesBuffer(store.getState(), id);
          if (latest && isFilesTextBuffer(latest) && latest.loadState === "loading") {
            store.getState().restoreTextContent(id, {
              text: slice.content,
              truncated: slice.truncated,
            });
          }
        } catch (error) {
          const latest = findFilesBuffer(store.getState(), id);
          if (latest && isFilesTextBuffer(latest) && latest.loadState === "loading") {
            store.getState().setTextLoadState(id, "error");
          }
          logger.warn("[files-workbench] 恢复文件失败", { path: current.path, error });
        }
      });

      let trackedRequest: Promise<void>;
      trackedRequest = request.then(
        () => {
          if (restoreLoadsRef.current.get(id) === trackedRequest) {
            restoreLoadsRef.current.delete(id);
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

  const openExistingPath = useCallback(
    async (workspace: FilesWorkspaceRef, path: string, mode: FilesOpenMode = "keep") => {
      const previousOpenIds = store.getState().openIds;
      const existing = findFilesFileBuffer(store.getState(), workspace, path);
      if (existing) {
        store.getState().openBuffer(existing, mode);
        persist();
        if (isFilesTextBuffer(existing)) {
          const current = findFilesBuffer(store.getState(), existing.id);
          if (
            current &&
            isFilesTextBuffer(current) &&
            (current.loadState === "unloaded" ||
              current.loadState === "error" ||
              (current.loadState === "loading" && !restoreLoadsRef.current.has(current.id)))
          ) {
            // A tab can be re-opened while its restored buffer is still empty.
            // Never leave a stale `loading` flag blocking retries after competing opens.
            if (current.loadState === "loading") {
              store.getState().setTextLoadState(current.id, "unloaded");
            }
            void loadRestoredTextFile(current.id);
          }
        }
        return;
      }
      const kind = resolveFilesBufferKind(path);
      if (kind === "preview") {
        store.getState().openBuffer(createPreviewBuffer({ workspace, path }), mode);
      } else {
        try {
          const slice = await resolveServices(workspace).fileService.readTextFile({
            path,
            length: FILE_VIEWER_MAX_TEXT_BYTES,
          });
          store.getState().openBuffer(
            createTextFileBuffer({
              workspace,
              path,
              text: slice.content,
              truncated: slice.truncated,
            }),
            mode,
          );
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
      await fileService.writeTextFile({ path, content: buffer.text });
      store.getState().markSaved(buffer.id, {
        path,
        text: buffer.text,
        workspace: buffer.workspace,
      });
      if (path !== buffer.path) {
        disposeFilesMonacoModel(buffer.id);
      }
      persist();
      return true;
    },
    [persist, resolveServices, store],
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

  const { closeView, closeOtherViews, resumePendingCloseOthers, cancelPendingCloseOthers } =
    useFilesEditorCloseActions({
      store,
      persist,
      closeBuffer,
      onDirtyBuffer: setDirtyCloseBufferId,
    });

  const closeGroup = useCallback(
    async (groupId: string) => {
      setPendingCloseGroupId(groupId);
      const views = [...(store.getState().layout.groups[groupId]?.views ?? [])];
      for (const view of views) {
        await closeView(view.bufferId, view.id);
        if (findFilesEditorGroupForView(store.getState().layout, view.id)) return;
      }
      store.getState().closeGroup(groupId);
      persist();
      setPendingCloseGroupId((current) => (current === groupId ? undefined : current));
    },
    [closeView, persist, store],
  );

  const resumePendingCloseGroup = useCallback(async () => {
    if (pendingCloseGroupId) await closeGroup(pendingCloseGroupId);
  }, [closeGroup, pendingCloseGroupId]);

  const cancelPendingCloseGroup = useCallback(() => {
    setPendingCloseGroupId(undefined);
    cancelPendingCloseOthers();
  }, [cancelPendingCloseOthers]);

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
    if (!pendingOpen || !store.getState().beginPendingOpen(pendingOpen)) return;
    void (async () => {
      try {
        await openExistingPath(
          pendingOpen.workspace,
          pendingOpen.path,
          pendingOpen.preview === true ? "preview" : "keep",
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
        setPendingCloseGroupId(undefined);
        cancelPendingCloseOthers();
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
      if (resolved && pendingCloseGroupId) await closeGroup(pendingCloseGroupId);
      else if (resolved) resumePendingCloseOthers();
    },
    [
      cancelPendingCloseOthers,
      closeGroup,
      conflictBuffer,
      pendingCloseGroupId,
      persist,
      resolveServices,
      resumePendingCloseOthers,
      saveTextBuffer,
      store,
    ],
  );

  const handleDirtyCloseDecision = useCallback(
    async (decision: FilesDirtyCloseDecision) => {
      const id = dirtyCloseBufferId;
      setDirtyCloseBufferId(undefined);
      if (!id) return;
      if (decision === "cancel") {
        setPendingCloseGroupId(undefined);
        cancelPendingCloseOthers();
        return;
      }
      await closeBuffer(id, decision);
      // Save may be deferred by a conflict or Save As dialog; resume only after it closes.
      if (!findFilesBuffer(store.getState(), id)) {
        if (pendingCloseGroupId) await closeGroup(pendingCloseGroupId);
        else resumePendingCloseOthers();
      }
    },
    [
      cancelPendingCloseOthers,
      closeBuffer,
      closeGroup,
      dirtyCloseBufferId,
      pendingCloseGroupId,
      resumePendingCloseOthers,
      store,
    ],
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
    closeBuffer,
    closeView,
    closeOtherViews,
    resumePendingCloseOthers,
    closeGroup,
    resumePendingCloseGroup,
    cancelPendingCloseGroup,
    persist,
    handleConflictDecision,
    handleDirtyCloseDecision,
  };
}
