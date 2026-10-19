import { findFilesEditorView } from "@/files-workbench/filesEditorLayout.js";
import type { FilesEditorLayoutState } from "@/files-workbench/filesEditorLayout.js";
import {
  removeFilesEditorView,
  removeFilesEditorViewsForBuffer,
} from "@/files-workbench/filesEditorLayoutOperations.js";
import { findFilesBuffer, isFilesBufferDirty } from "@/files-workbench/filesEditorModel.js";
import type { FilesBuffer, FilesEditorState } from "@/files-workbench/filesEditorTypes.js";

export interface FilesEditorClosePlan {
  viewIdsToRemove: string[];
  bufferIdsToClose: string[];
  dirtyBufferId?: string;
}

/** Plan arbitrary editor-view removals from one snapshot, stopping at the first dirty last view. */
export function planFilesEditorCloseTargets(
  state: FilesEditorState,
  layout: FilesEditorLayoutState,
  requestedViewIds: readonly string[],
): FilesEditorClosePlan {
  const empty: FilesEditorClosePlan = { viewIdsToRemove: [], bufferIdsToClose: [] };
  if (requestedViewIds.length === 0) return empty;

  const requestedIds = new Set(requestedViewIds);
  const allViews = Object.values(layout.groups).flatMap((entry) => entry.views);
  const toClose = allViews.filter((view) => requestedIds.has(view.id));
  if (toClose.length === 0) return empty;

  const targetViewIds = new Set(toClose.map((view) => view.id));
  const viewIdsToRemove: string[] = [];
  const bufferIdsToClose: string[] = [];
  const scheduledBufferIds = new Set<string>();
  let dirtyBufferId: string | undefined;

  for (const view of toClose) {
    const buffer = findFilesBuffer(state, view.bufferId);
    if (!buffer) {
      viewIdsToRemove.push(view.id);
      continue;
    }
    if (scheduledBufferIds.has(buffer.id)) continue;

    // A buffer shared with a view outside this operation stays open; only this view is removed.
    const hasViewOutsideTarget = allViews.some(
      (candidate) => candidate.bufferId === buffer.id && !targetViewIds.has(candidate.id),
    );
    if (hasViewOutsideTarget) {
      viewIdsToRemove.push(view.id);
      continue;
    }
    if (isFilesBufferDirty(buffer)) {
      dirtyBufferId = buffer.id;
      break;
    }
    scheduledBufferIds.add(buffer.id);
    bufferIdsToClose.push(buffer.id);
  }

  return {
    viewIdsToRemove,
    bufferIdsToClose,
    ...(dirtyBufferId ? { dirtyBufferId } : undefined),
  };
}

/** Plan a close-others operation for one group, preserving the clicked tab. */
export function planFilesEditorCloseOthers(
  state: FilesEditorState,
  layout: FilesEditorLayoutState,
  keepBufferId: string,
  keepViewId: string,
  groupId: string,
): FilesEditorClosePlan {
  const keepView = findFilesEditorView(layout, keepViewId);
  const group = layout.groups[groupId];
  if (
    !keepView ||
    keepView.bufferId !== keepBufferId ||
    !group?.views.some((view) => view.id === keepViewId)
  ) {
    return { viewIdsToRemove: [], bufferIdsToClose: [] };
  }

  return planFilesEditorCloseTargets(
    state,
    layout,
    group.views.filter((view) => view.id !== keepViewId).map((view) => view.id),
  );
}

/** Apply many view/buffer removals in one store update rather than publishing each tab close. */
export function applyFilesEditorClosePlan(
  state: FilesEditorState,
  layout: FilesEditorLayoutState,
  plan: Pick<FilesEditorClosePlan, "viewIdsToRemove" | "bufferIdsToClose">,
): Pick<FilesEditorState, "buffers" | "openIds" | "activeId"> & {
  layout: FilesEditorLayoutState;
} {
  const closedBufferIds = new Set(plan.bufferIdsToClose);
  let nextLayout = layout;
  for (const bufferId of closedBufferIds) {
    nextLayout = removeFilesEditorViewsForBuffer(nextLayout, bufferId);
  }
  for (const viewId of plan.viewIdsToRemove) {
    nextLayout = removeFilesEditorView(nextLayout, viewId);
  }
  const focusedGroup = nextLayout.groups[nextLayout.focusedGroupId];
  const activeView = focusedGroup?.views.find((view) => view.id === focusedGroup.activeViewId);
  return {
    buffers: state.buffers.filter((buffer: FilesBuffer) => !closedBufferIds.has(buffer.id)),
    openIds: state.openIds.filter((id) => !closedBufferIds.has(id)),
    activeId: activeView?.bufferId,
    layout: nextLayout,
  };
}
