import { create } from "zustand";
import { createUuid } from "@zcode/shared";
import {
  createEmptyFilesEditorLayout,
  findFilesEditorGroupForView,
  findFilesEditorGroupsForBuffer,
  findFilesEditorView,
  focusFilesEditorGroup,
  focusFilesEditorView,
  setFilesEditorBranchRatio,
  replaceFilesEditorViewBuffer,
} from "@/files-workbench/filesEditorLayout.js";
import type {
  FilesEditorLayoutState,
  FilesEditorSplitEdge,
} from "@/files-workbench/filesEditorLayout.js";
import {
  moveFilesEditorViewToGroup,
  removeFilesEditorGroup,
  removeFilesEditorView,
  removeFilesEditorViewsForBuffer,
  splitFilesEditorViewToEdge,
} from "@/files-workbench/filesEditorLayoutOperations.js";
import {
  addBufferToFocusedGroup,
  focusBufferInLayout,
  reconcileOpenedBuffer,
} from "@/files-workbench/filesEditorStoreLayout.js";
import type { FilesPendingOpen } from "@/files-workbench/filesEditorTypes.js";
import { createFilesEditorOpenRequestActions } from "@/files-workbench/filesEditorStoreOpenRequests.js";
import {
  closeBufferInState,
  createUntitledTextBuffer,
  filesWorkspaceKey,
  loadTextBufferInState,
  openBufferInState,
  persistableDrafts,
  persistableOpenTabs,
  resolveExplorerWorkspaceKey,
  setTextBufferLoadStateInState,
  updateTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { applyFilesEditorClosePlan } from "@/files-workbench/filesEditorCloseOperations.js";
import type { FilesEditorClosePlan } from "@/files-workbench/filesEditorCloseOperations.js";
import { restoreFilesEditorSession } from "@/files-workbench/filesEditorStoreSession.js";
import {
  applyFilesEditorFileMutation,
  type FilesEditorFileMutation,
} from "@/files-workbench/filesEditorFileMutations.js";
import type {
  FilesBuffer,
  FilesEditorFocusRequest,
  FilesEditorState,
  FilesOpenMode,
  FilesPersistedSession,
  FilesTextBufferLoadState,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

const EMPTY_STATE: FilesEditorState = {
  buffers: [],
  openIds: [],
  untitledSerial: 1,
};

export interface FilesEditorStoreState extends FilesEditorState {
  lastFileMutation?: FilesEditorFileMutation;
  applyFileMutation: (mutation: FilesEditorFileMutation) => void;
  layout: FilesEditorLayoutState;
  openBuffer: (buffer: FilesBuffer, mode?: FilesOpenMode) => void;
  closeBuffer: (id: string) => void;
  closeViewsAndBuffers: (plan: FilesEditorClosePlan) => void;
  setActiveId: (id: string) => void;
  activateView: (viewId: string) => void;
  focusGroup: (groupId: string) => void;
  moveViewToGroup: (viewId: string, groupId: string, targetIndex?: number) => void;
  setBranchRatio: (branchId: string, ratio: number) => void;
  splitViewToEdge: (
    viewId: string,
    groupId: string,
    edge: FilesEditorSplitEdge,
    mode?: "move" | "copy",
  ) => void;
  removeView: (viewId: string) => void;
  closeGroup: (groupId: string) => void;
  updateText: (id: string, text: string) => void;
  setTextLoadState: (id: string, loadState: FilesTextBufferLoadState | undefined) => void;
  restoreTextContent: (id: string, params: { text: string; truncated?: boolean }) => void;
  markSaved: (
    id: string,
    params: {
      path: string;
      text: string;
      workspace: FilesWorkspaceRef;
      preserveCurrentText?: boolean;
    },
  ) => void;
  createUntitled: (workspace: FilesWorkspaceRef) => string;
  setExplorerWorkspaceKey: (key?: string) => void;
  setRevealPath: (path?: string) => void;
  setPendingSaveDirectory: (path?: string) => void;
  requestOpenPath: (params: {
    workspace: FilesWorkspaceRef;
    path: string;
    preview?: boolean;
    /** 打开后把键盘焦点交给目标编辑器（⌘P 搜索中心确认）。 */
    focus?: boolean;
  }) => void;
  /**
   * 打开文件后的编辑器聚焦意图。请求可能早于编辑器创建发出，
   * 目标编辑器就绪时消费同一个 requestId 即可生效。
   */
  editorFocusRequest?: FilesEditorFocusRequest;
  editorFocusRequestId: number;
  clearEditorFocusRequest: (requestId: number) => void;
  pendingOpenInFlight?: FilesPendingOpen;
  beginPendingOpen: (request: FilesPendingOpen) => boolean;
  completePendingOpen: (request: FilesPendingOpen) => void;
  clearPendingOpen: () => void;
  hydrateSession: (session: FilesPersistedSession) => void;
  snapshotSession: () => FilesPersistedSession;
  resolveExplorerKey: (workspaceKeys: readonly string[]) => string | undefined;
}

export function createFilesEditorStore() {
  return create<FilesEditorStoreState>()((set, get) => ({
    ...EMPTY_STATE,
    layout: createEmptyFilesEditorLayout(`files-group-${createUuid()}`),

    applyFileMutation: (mutation) => {
      set((state) => applyFilesEditorFileMutation(state, mutation));
    },

    openBuffer: (buffer, mode = "keep") => {
      set((state) => {
        const next = openBufferInState(state, buffer, mode);
        const layout = reconcileOpenedBuffer(
          state.layout,
          state.openIds,
          next.openIds,
          buffer.id,
          mode,
        );
        const activeView = layout.groups[layout.focusedGroupId]?.views.find(
          (view) => view.bufferId === buffer.id,
        );
        const focusedLayout = activeView
          ? focusFilesEditorView(layout, layout.focusedGroupId, activeView.id)
          : layout;
        return { ...next, layout: focusedLayout, activeId: buffer.id };
      });
    },

    closeBuffer: (id) => {
      set((state) => {
        const next = closeBufferInState(state, id);
        const layout = removeFilesEditorViewsForBuffer(state.layout, id);
        const focusedGroup = layout.groups[layout.focusedGroupId];
        const activeView = focusedGroup?.views.find(
          (view) => view.id === focusedGroup.activeViewId,
        );
        return {
          ...next,
          layout,
          activeId: activeView?.bufferId,
        };
      });
    },

    closeViewsAndBuffers: (plan) => {
      if (plan.viewIdsToRemove.length === 0 && plan.bufferIdsToClose.length === 0) return;
      set((state) => ({ ...state, ...applyFilesEditorClosePlan(state, state.layout, plan) }));
    },

    setActiveId: (id) => {
      set((state) => {
        if (!state.openIds.includes(id)) return state;
        const layout = addBufferToFocusedGroup(state.layout, id);
        const focusedView = layout.groups[layout.focusedGroupId]?.views.find(
          (view) => view.bufferId === id,
        );
        const focusedLayout = focusedView
          ? focusFilesEditorView(layout, layout.focusedGroupId, focusedView.id)
          : focusBufferInLayout(layout, id);
        return { layout: focusedLayout, activeId: id };
      });
    },

    activateView: (viewId) => {
      set((state) => {
        const groupId = findFilesEditorGroupForView(state.layout, viewId);
        const view = findFilesEditorView(state.layout, viewId);
        if (!groupId || !view) return state;
        return {
          layout: focusFilesEditorView(state.layout, groupId, viewId),
          activeId: view.bufferId,
        };
      });
    },

    focusGroup: (groupId) => {
      set((state) => {
        const group = state.layout.groups[groupId];
        if (!group) return state;
        const layout = focusFilesEditorGroup(state.layout, groupId);
        const activeView = group.views.find((view) => view.id === group.activeViewId);
        return { layout, activeId: activeView?.bufferId };
      });
    },

    moveViewToGroup: (viewId, groupId, targetIndex) => {
      set((state) => {
        const layout = moveFilesEditorViewToGroup(state.layout, viewId, groupId, targetIndex);
        const view = layout.groups[groupId]?.views.find((candidate) => candidate.id === viewId);
        return {
          layout,
          ...(view ? { activeId: view.bufferId } : undefined),
        };
      });
    },

    setBranchRatio: (branchId, ratio) => {
      set((state) => ({ layout: setFilesEditorBranchRatio(state.layout, branchId, ratio) }));
    },

    splitViewToEdge: (viewId, groupId, edge, mode = "move") => {
      set((state) => {
        const view = findFilesEditorView(state.layout, viewId);
        if (!view) return state;
        const layout = splitFilesEditorViewToEdge(
          state.layout,
          viewId,
          groupId,
          edge,
          {
            groupId: `files-group-${createUuid()}`,
            branchId: `files-branch-${createUuid()}`,
            ...(mode === "copy" ? { viewId: `files-view-${createUuid()}` } : undefined),
          },
          mode,
        );
        const activeView = layout.groups[layout.focusedGroupId]?.views.find(
          (candidate) =>
            candidate.id ===
            (mode === "copy" ? layout.groups[layout.focusedGroupId]?.activeViewId : viewId),
        );
        return { layout, activeId: activeView?.bufferId ?? view.bufferId };
      });
    },

    removeView: (viewId) => {
      set((state) => {
        // A view-only close must not close the shared buffer; remove exactly this view.
        const nextLayout = removeFilesEditorView(state.layout, viewId);
        const group = nextLayout.groups[nextLayout.focusedGroupId];
        const activeView = group?.views.find((view) => view.id === group.activeViewId);
        return { layout: nextLayout, activeId: activeView?.bufferId };
      });
    },

    closeGroup: (groupId) => {
      set((state) => {
        const layout = removeFilesEditorGroup(state.layout, groupId);
        const group = layout.groups[layout.focusedGroupId];
        const activeView = group?.views.find((view) => view.id === group.activeViewId);
        return { layout, activeId: activeView?.bufferId };
      });
    },

    updateText: (id, text) => {
      set((state) => updateTextBuffer(state, id, { text }));
    },

    setTextLoadState: (id, loadState) => {
      set((state) => setTextBufferLoadStateInState(state, id, loadState));
    },

    restoreTextContent: (id, params) => {
      set((state) => loadTextBufferInState(state, id, params));
    },

    markSaved: (id, params) => {
      const nextId = `file:${filesWorkspaceKey(params.workspace)}:${params.path}`;
      const title = params.path.split(/[\\/]/).filter(Boolean).at(-1) ?? params.path;
      set((state) => {
        const source = state.buffers.find((buffer) => buffer.id === id);
        // 路径变更或关闭已使旧保存目标失效；不能让异步保存的完成通知重建旧缓冲。
        if (!source || source.kind !== "text") return state;
        const text = params.preserveCurrentText ? source.text : params.text;
        if (id === nextId) {
          return updateTextBuffer(state, id, {
            text,
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
          text,
          savedText: params.text,
          workspace: params.workspace,
        };
        const next = openBufferInState(closed, savedBuffer);
        const targetAlreadyVisible =
          findFilesEditorGroupsForBuffer(state.layout, nextId).length > 0;
        let layout = targetAlreadyVisible
          ? removeFilesEditorViewsForBuffer(state.layout, id)
          : state.layout;
        if (!targetAlreadyVisible) {
          const oldViews = Object.values(layout.groups).flatMap((group) =>
            group.views.filter((view) => view.bufferId === id).map((view) => view.id),
          );
          for (const viewId of oldViews) {
            layout = replaceFilesEditorViewBuffer(layout, viewId, nextId);
          }
        }
        layout = addBufferToFocusedGroup(layout, nextId);
        return { ...next, layout, activeId: nextId };
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
      get().openBuffer(buffer);
      set({ untitledSerial: serial + 1 });
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

    ...createFilesEditorOpenRequestActions(set),

    editorFocusRequestId: 0,
    clearEditorFocusRequest: (requestId) => {
      set((state) =>
        state.editorFocusRequest?.requestId === requestId
          ? { editorFocusRequest: undefined }
          : state,
      );
    },

    hydrateSession: (session) => {
      set((state) => ({
        ...state,
        ...restoreFilesEditorSession(session, state.untitledSerial),
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
