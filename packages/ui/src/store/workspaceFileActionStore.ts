import { nanoid } from "nanoid";
import { create } from "zustand";
import type { WorkspaceFileActionTarget } from "../workspace-file-tree/fileActionRules.js";

export interface WorkspaceFileClipboardInput extends WorkspaceFileActionTarget {
  operation: "copy" | "cut";
  type: "file" | "directory";
  name: string;
}

export interface WorkspaceFileClipboardEntry extends WorkspaceFileClipboardInput {
  id: string;
}

interface WorkspaceFileActionStoreState {
  clipboard: WorkspaceFileClipboardEntry | null;
  busyWorkspaceKeys: string[];
  setClipboard: (input: WorkspaceFileClipboardInput) => string;
  clearClipboard: (expectedId?: string) => void;
  beginOperation: (workspaceKey: string) => boolean;
  endOperation: (workspaceKey: string) => void;
}

export const useWorkspaceFileActionStore = create<WorkspaceFileActionStoreState>((set, get) => ({
  clipboard: null,
  busyWorkspaceKeys: [],
  setClipboard: (input) => {
    const id = nanoid();
    set({ clipboard: { ...input, id } });
    return id;
  },
  clearClipboard: (expectedId) => {
    set((state) => {
      // 异步移动完成时只消费本次剪切项，避免清掉等待期间用户新复制的文件。
      if (!state.clipboard || (expectedId !== undefined && state.clipboard.id !== expectedId)) {
        return state;
      }
      return { clipboard: null };
    });
  },
  beginOperation: (workspaceKey) => {
    if (get().busyWorkspaceKeys.includes(workspaceKey)) {
      return false;
    }
    set((state) => ({ busyWorkspaceKeys: [...state.busyWorkspaceKeys, workspaceKey] }));
    return true;
  },
  endOperation: (workspaceKey) => {
    set((state) => {
      if (!state.busyWorkspaceKeys.includes(workspaceKey)) {
        return state;
      }
      return { busyWorkspaceKeys: state.busyWorkspaceKeys.filter((key) => key !== workspaceKey) };
    });
  },
}));
