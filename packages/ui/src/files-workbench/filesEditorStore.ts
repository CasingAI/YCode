import { create } from "zustand";
import { createUuid } from "@zcode/shared";
import {
  closeBufferInState,
  createUntitledTextBuffer,
  filesWorkspaceKey,
  openBufferInState,
  persistableDrafts,
  persistableOpenTabs,
  resolveExplorerWorkspaceKey,
  updateTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import type {
  FilesBuffer,
  FilesEditorState,
  FilesOpenMode,
  FilesPersistedSession,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

const EMPTY_STATE: FilesEditorState = {
  buffers: [],
  openIds: [],
  untitledSerial: 1,
};

export interface FilesEditorStoreState extends FilesEditorState {
  openBuffer: (buffer: FilesBuffer, mode?: FilesOpenMode) => void;
  closeBuffer: (id: string) => void;
  setActiveId: (id: string) => void;
  updateText: (id: string, text: string) => void;
  markSaved: (id: string, params: { path: string; text: string; workspace: FilesWorkspaceRef }) => void;
  createUntitled: (workspace: FilesWorkspaceRef) => string;
  setExplorerWorkspaceKey: (key?: string) => void;
  setRevealPath: (path?: string) => void;
  setPendingSaveDirectory: (path?: string) => void;
  requestOpenPath: (params: {
    workspace: FilesWorkspaceRef;
    path: string;
    preview?: boolean;
  }) => void;
  clearPendingOpen: () => void;
  hydrateSession: (session: FilesPersistedSession) => void;
  snapshotSession: () => FilesPersistedSession;
  resolveExplorerKey: (workspaceKeys: readonly string[]) => string | undefined;
}

export function createFilesEditorStore() {
  return create<FilesEditorStoreState>()((set, get) => ({
    ...EMPTY_STATE,

    openBuffer: (buffer, mode = "keep") => {
      set((state) => openBufferInState(state, buffer, mode));
    },

    closeBuffer: (id) => {
      set((state) => closeBufferInState(state, id));
    },

    setActiveId: (id) => {
      set({ activeId: id });
    },

    updateText: (id, text) => {
      set((state) => updateTextBuffer(state, id, { text }));
    },

    markSaved: (id, params) => {
      const nextId = `file:${filesWorkspaceKey(params.workspace)}:${params.path}`;
      const title = params.path.split(/[\\/]/).filter(Boolean).at(-1) ?? params.path;
      set((state) => {
        if (id === nextId) {
          return updateTextBuffer(state, id, {
            text: params.text,
            savedText: params.text,
            path: params.path,
            untitled: false,
            title,
          });
        }
        const closed = closeBufferInState(state, id);
        const savedBuffer: FilesBuffer = {
          id: nextId,
          kind: "text",
          untitled: false,
          path: params.path,
          title,
          text: params.text,
          savedText: params.text,
          workspace: params.workspace,
        };
        return openBufferInState(closed, savedBuffer);
      });
    },

    createUntitled: (workspace) => {
      const serial = get().untitledSerial;
      const id = `untitled:${createUuid()}`;
      const buffer = createUntitledTextBuffer({
        id,
        title: `Untitled-${serial}`,
        workspace,
      });
      set((state) => ({
        ...openBufferInState(state, buffer),
        untitledSerial: serial + 1,
      }));
      return id;
    },

    setExplorerWorkspaceKey: (key) => {
      set({ explorerWorkspaceKey: key });
    },

    setRevealPath: (path) => {
      set({ revealPath: path });
    },

    setPendingSaveDirectory: (path) => {
      set({ pendingSaveDirectory: path });
    },

    requestOpenPath: (params) => {
      set({
        pendingOpen: {
          workspace: params.workspace,
          path: params.path,
          preview: params.preview,
        },
        explorerWorkspaceKey: filesWorkspaceKey(params.workspace),
        revealPath: params.path,
      });
    },

    clearPendingOpen: () => {
      set({ pendingOpen: undefined });
    },

    hydrateSession: (session) => {
      const draftBuffers: FilesBuffer[] = session.drafts.map((draft) => ({
        id: draft.id,
        kind: "text",
        untitled: draft.untitled,
        path: draft.path,
        title: draft.title,
        text: draft.text,
        savedText: draft.savedText,
        workspace: draft.workspace,
      }));
      set((state) => ({
        ...state,
        buffers: draftBuffers,
        explorerWorkspaceKey: session.explorerWorkspaceKey,
        activeId: session.activeId,
        openIds: session.openFileIds,
        untitledSerial: Math.max(
          state.untitledSerial,
          session.drafts.filter((draft) => draft.untitled).length + 1,
        ),
      }));
    },

    snapshotSession: (): FilesPersistedSession => {
      const state = get();
      const openTabs = persistableOpenTabs(state);
      return {
        version: 1,
        explorerWorkspaceKey: state.explorerWorkspaceKey,
        activeId: state.activeId,
        openFileIds: openTabs.map((tab) => tab.id),
        openTabs,
        drafts: persistableDrafts(state),
      };
    },

    resolveExplorerKey: (workspaceKeys) =>
      resolveExplorerWorkspaceKey({
        preferredKey: get().explorerWorkspaceKey,
        workspaceKeys,
      }),
  }));
}

export type FilesEditorStore = ReturnType<typeof createFilesEditorStore>;
