import { useCallback, useRef } from "react";
import { planFilesEditorCloseTargets } from "@/files-workbench/filesEditorCloseOperations.js";
import {
  findFilesEditorGroupsForBuffer,
  findFilesEditorView,
} from "@/files-workbench/filesEditorLayout.js";
import { disposeFilesMonacoModel } from "@/files-workbench/filesMonacoModels.js";
import { findFilesBuffer, isFilesBufferDirty } from "@/files-workbench/filesEditorModel.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";

interface PendingCloseAction {
  viewIds: string[];
}

/** Coordinate batch-close confirmations without publishing one store update per tab. */
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
  const pendingCloseActionRef = useRef<PendingCloseAction | undefined>(undefined);

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

  const closeTargetViews = useCallback(
    (requestedViewIds: readonly string[]) => {
      const state = store.getState();
      const viewIds = requestedViewIds.filter((viewId) =>
        Boolean(findFilesEditorView(state.layout, viewId)),
      );
      if (viewIds.length === 0) {
        pendingCloseActionRef.current = undefined;
        return;
      }

      const plan = planFilesEditorCloseTargets(state, state.layout, viewIds);
      if (plan.viewIdsToRemove.length > 0 || plan.bufferIdsToClose.length > 0) {
        store.getState().closeViewsAndBuffers(plan);
        plan.bufferIdsToClose.forEach(disposeFilesMonacoModel);
        persist();
      }
      // Keep original IDs so the batch can continue after each dirty buffer is resolved.
      pendingCloseActionRef.current = plan.dirtyBufferId ? { viewIds } : undefined;
      if (plan.dirtyBufferId) onDirtyBuffer(plan.dirtyBufferId);
    },
    [onDirtyBuffer, persist, store],
  );

  const closeOtherViews = useCallback(
    (keepBufferId: string, keepViewId: string, groupId: string) => {
      const state = store.getState();
      const keepView = findFilesEditorView(state.layout, keepViewId);
      const group = state.layout.groups[groupId];
      if (
        !keepView ||
        keepView.bufferId !== keepBufferId ||
        !group?.views.some((view) => view.id === keepViewId)
      ) {
        return;
      }
      closeTargetViews(group.views.filter((view) => view.id !== keepViewId).map((view) => view.id));
    },
    [closeTargetViews, store],
  );

  const closeViewsToRight = useCallback(
    (viewId: string, groupId: string) => {
      const group = store.getState().layout.groups[groupId];
      if (!group) return;
      const index = group.views.findIndex((view) => view.id === viewId);
      if (index < 0) return;
      closeTargetViews(group.views.slice(index + 1).map((view) => view.id));
    },
    [closeTargetViews, store],
  );

  const closeSavedViews = useCallback(() => {
    const state = store.getState();
    const viewIds = Object.values(state.layout.groups).flatMap((group) =>
      group.views.flatMap((view) => {
        const buffer = findFilesBuffer(state, view.bufferId);
        return buffer && !isFilesBufferDirty(buffer) ? [view.id] : [];
      }),
    );
    closeTargetViews(viewIds);
  }, [closeTargetViews, store]);

  const closeAllViews = useCallback(() => {
    const state = store.getState();
    const viewIds = Object.values(state.layout.groups).flatMap((group) =>
      group.views.map((view) => view.id),
    );
    closeTargetViews(viewIds);
  }, [closeTargetViews, store]);

  const resumePendingClose = useCallback(() => {
    const pending = pendingCloseActionRef.current;
    if (pending) closeTargetViews(pending.viewIds);
  }, [closeTargetViews]);

  const cancelPendingClose = useCallback(() => {
    pendingCloseActionRef.current = undefined;
  }, []);

  return {
    closeView,
    closeOtherViews,
    closeViewsToRight,
    closeSavedViews,
    closeAllViews,
    resumePendingClose,
    cancelPendingClose,
  };
}
