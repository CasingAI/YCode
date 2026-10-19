import type { StoreApi } from "zustand";
import type { FilesEditorStoreState } from "@/files-workbench/filesEditorStore.js";
import type { FilesPendingOpen } from "@/files-workbench/filesEditorTypes.js";
import { filesWorkspaceKey } from "@/files-workbench/filesEditorModel.js";

type OpenRequestActions = Pick<
  FilesEditorStoreState,
  "requestOpenPath" | "beginPendingOpen" | "completePendingOpen" | "clearPendingOpen"
>;

export function createFilesEditorOpenRequestActions(
  set: StoreApi<FilesEditorStoreState>["setState"],
): OpenRequestActions {
  return {
    requestOpenPath: (params) => {
      set((state) => {
        const request: FilesPendingOpen = {
          workspace: params.workspace,
          path: params.path,
          preview: params.preview,
        };
        const queue = [
          ...(state.pendingOpenQueue ?? (state.pendingOpen ? [state.pendingOpen] : [])),
          request,
        ];
        return {
          pendingOpen: queue[0],
          pendingOpenQueue: queue,
          explorerWorkspaceKey: filesWorkspaceKey(params.workspace),
          revealPath: params.path,
        };
      });
    },

    beginPendingOpen: (request) => {
      let claimed = false;
      set((state) => {
        if (state.pendingOpen !== request || state.pendingOpenInFlight) return state;
        claimed = true;
        return { pendingOpenInFlight: request };
      });
      return claimed;
    },

    completePendingOpen: (request) => {
      set((state) => {
        if (state.pendingOpenInFlight !== request) return state;
        const queue = [
          ...(state.pendingOpenQueue ?? (state.pendingOpen ? [state.pendingOpen] : [])),
        ];
        if (queue[0] === request) queue.shift();
        return {
          pendingOpen: queue[0],
          pendingOpenQueue: queue.length > 0 ? queue : undefined,
          pendingOpenInFlight: undefined,
        };
      });
    },

    clearPendingOpen: () => {
      set((state) => {
        const queue = [
          ...(state.pendingOpenQueue ?? (state.pendingOpen ? [state.pendingOpen] : [])),
        ];
        queue.shift();
        return {
          pendingOpen: queue[0],
          pendingOpenQueue: queue.length > 0 ? queue : undefined,
          pendingOpenInFlight: undefined,
        };
      });
    },
  };
}
