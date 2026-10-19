import { useCallback, useRef } from "react";
import { planFilesEditorCloseOthers } from "@/files-workbench/filesEditorCloseOperations.js";
import {
  findFilesEditorGroupsForBuffer,
  findFilesEditorView,
} from "@/files-workbench/filesEditorLayout.js";
import { disposeFilesMonacoModel } from "@/files-workbench/filesMonacoModels.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";

interface PendingCloseOthers {
  keepBufferId: string;
  keepViewId: string;
  groupId: string;
}

/** Coordinate close-others confirmations without publishing one store update per tab. */
export function useFilesEditorCloseActions({
  store,
  persist,
  closeBuffer,
  onDirtyBuffer,
}: {
  store: FilesEditorStore;
  persist: () => void;
  closeBuffer: (bufferId: string) => Promise<void>;
  onDirtyBuffer: (bufferId: string) => void;
}) {
  const pendingCloseOthersRef = useRef<PendingCloseOthers | undefined>(undefined);

  const closeView = useCallback(
    async (bufferId: string, viewId: string) => {
      const state = store.getState();
      const view = findFilesEditorView(state.layout, viewId);
      if (!view || view.bufferId !== bufferId) return;
      const groupIds = findFilesEditorGroupsForBuffer(state.layout, bufferId);
      const hasOtherView = groupIds.some((groupId) =>
        state.layout.groups[groupId]?.views.some(
          (candidate) => candidate.id !== viewId && candidate.bufferId === bufferId,
        ),
      );
      if (hasOtherView) {
        state.removeView(viewId);
        persist();
        return;
      }
      await closeBuffer(bufferId);
    },
    [closeBuffer, persist, store],
  );

  const closeOtherViews = useCallback(
    (keepBufferId: string, keepViewId: string, groupId: string) => {
      const state = store.getState();
      const plan = planFilesEditorCloseOthers(
        state,
        state.layout,
        keepBufferId,
        keepViewId,
        groupId,
      );
      if (plan.viewIdsToRemove.length > 0 || plan.bufferIdsToClose.length > 0) {
        store.getState().closeViewsAndBuffers(plan);
        plan.bufferIdsToClose.forEach(disposeFilesMonacoModel);
        persist();
      }
      // Retain the anchor until each dirty file has been resolved or the operation is canceled.
      pendingCloseOthersRef.current = plan.dirtyBufferId
        ? { keepBufferId, keepViewId, groupId }
        : undefined;
      if (plan.dirtyBufferId) onDirtyBuffer(plan.dirtyBufferId);
    },
    [onDirtyBuffer, persist, store],
  );

  const resumePendingCloseOthers = useCallback(() => {
    const pending = pendingCloseOthersRef.current;
    if (pending) closeOtherViews(pending.keepBufferId, pending.keepViewId, pending.groupId);
  }, [closeOtherViews]);

  const cancelPendingCloseOthers = useCallback(() => {
    pendingCloseOthersRef.current = undefined;
  }, []);

  return { closeView, closeOtherViews, resumePendingCloseOthers, cancelPendingCloseOthers };
}
