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
import { resolveFilesWorkspaceServices } from "@/files-workbench/filesWorkspaceFileService.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";
import type {
  FilesBuffer,
  FilesDirtyCloseDecision,
  FilesOpenMode,
  FilesSaveConflictDecision,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export function useFilesWorkbenchController() {
  const store = useFilesEditorStoreApi();
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const workspaceTabs = useTabStore(
    useShallow((state) => state.tabs.filter(isWorkspaceTab)),
  );
  const pendingOpen = useFilesEditorStore((state) => state.pendingOpen);
  const [saveAsBufferId, setSaveAsBufferId] = useState<string | undefined>();
  const [dirtyCloseBufferId, setDirtyCloseBufferId] = useState<string | undefined>();
  const [conflictBuffer, setConflictBuffer] = useState<FilesTextBuffer | undefined>();
  const restoredRef = useRef(false);

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

  const openExistingPath = useCallback(
    async (workspace: FilesWorkspaceRef, path: string, mode: FilesOpenMode = "keep") => {
      const previousOpenIds = store.getState().openIds;
      const existing = findFilesFileBuffer(store.getState(), workspace, path);
      if (existing) {
        store.getState().openBuffer(existing, mode);
        persist();
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
    [persist, resolveServices, store],
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

  useEffect(() => {
    if (restoredRef.current) {
      return;
    }
    restoredRef.current = true;
    const session = readFilesEditorSession();
    if (!session) {
      return;
    }
    store.getState().hydrateSession(session);
    for (const tab of session.openTabs) {
      if (tab.untitled || !tab.path) {
        continue;
      }
      const existing = findFilesBuffer(store.getState(), tab.id);
      if (existing && isFilesTextBuffer(existing) && isFilesBufferDirty(existing)) {
        continue;
      }
      void openExistingPath(tab.workspace, tab.path, tab.preview === true ? "preview" : "keep");
    }
  }, [openExistingPath, store]);

  useEffect(() => {
    if (!pendingOpen) {
      return;
    }
    void openExistingPath(
      pendingOpen.workspace,
      pendingOpen.path,
      pendingOpen.preview === true ? "preview" : "keep",
    );
    store.getState().clearPendingOpen();
  }, [openExistingPath, pendingOpen, store]);

  const handleConflictDecision = useCallback(
    async (decision: FilesSaveConflictDecision | "cancel") => {
      const buffer = conflictBuffer;
      setConflictBuffer(undefined);
      if (!buffer || decision === "cancel") {
        return;
      }
      if (decision === "overwrite") {
        await saveTextBuffer(buffer, { force: true });
        return;
      }
      if (!buffer.path) {
        return;
      }
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
      } catch (error) {
        logger.warn("[files-workbench] 冲突后重载失败", { path: buffer.path, error });
      }
    },
    [conflictBuffer, persist, resolveServices, saveTextBuffer, store],
  );

  const handleDirtyCloseDecision = useCallback(
    async (decision: FilesDirtyCloseDecision) => {
      const id = dirtyCloseBufferId;
      setDirtyCloseBufferId(undefined);
      if (!id || decision === "cancel") {
        return;
      }
      await closeBuffer(id, decision);
    },
    [closeBuffer, dirtyCloseBufferId],
  );

  const closeOtherBuffers = useCallback(
    async (keepId: string) => {
      const others = store.getState().openIds.filter((id) => id !== keepId);
      for (const id of others) {
        await closeBuffer(id);
        if (findFilesBuffer(store.getState(), id)) {
          return;
        }
      }
    },
    [closeBuffer, store],
  );

  return {
    saveAsBufferId,
    setSaveAsBufferId,
    dirtyCloseBufferId,
    conflictBuffer,
    resolveServices,
    openExistingPath,
    saveTextBuffer,
    closeBuffer,
    closeOtherBuffers,
    persist,
    handleConflictDecision,
    handleDirtyCloseDecision,
  };
}

export function filesActiveTextBuffer(buffers: readonly FilesBuffer[], activeId?: string) {
  const buffer = buffers.find((candidate) => candidate.id === activeId);
  return buffer && isFilesTextBuffer(buffer) ? buffer : undefined;
}
