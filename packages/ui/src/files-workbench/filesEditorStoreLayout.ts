import { createUuid } from "@zcode/shared";
import {
  addFilesEditorViewToGroup,
  createEmptyFilesEditorLayout,
  createFilesEditorLayoutWithViews,
  findFilesEditorGroupsForBuffer,
  focusFilesEditorView,
  replaceFilesEditorViewBuffer,
} from "@/files-workbench/filesEditorLayout.js";
import type { FilesEditorLayoutState } from "@/files-workbench/filesEditorLayout.js";
import { removeFilesEditorViewsForBuffer } from "@/files-workbench/filesEditorLayoutOperations.js";
import type { FilesOpenMode } from "@/files-workbench/filesEditorTypes.js";

export function isFilesEditorBufferActiveInLayout(
  layout: FilesEditorLayoutState,
  bufferId: string,
): boolean {
  return Object.values(layout.groups).some((group) => {
    const activeView = group.views.find((view) => view.id === group.activeViewId);
    return activeView?.bufferId === bufferId;
  });
}

export function focusBufferInLayout(
  layout: FilesEditorLayoutState,
  bufferId: string,
): FilesEditorLayoutState {
  const groupIds = findFilesEditorGroupsForBuffer(layout, bufferId);
  const preferredGroupId = groupIds.includes(layout.focusedGroupId)
    ? layout.focusedGroupId
    : groupIds[0];
  if (!preferredGroupId) return layout;
  const view = layout.groups[preferredGroupId]?.views.find(
    (candidate) => candidate.bufferId === bufferId,
  );
  return view ? focusFilesEditorView(layout, preferredGroupId, view.id) : layout;
}

export function addBufferToFocusedGroup(
  layout: FilesEditorLayoutState,
  bufferId: string,
): FilesEditorLayoutState {
  if (findFilesEditorGroupsForBuffer(layout, bufferId).length > 0) {
    return focusBufferInLayout(layout, bufferId);
  }
  let groupId = layout.focusedGroupId;
  if (!layout.groups[groupId]) {
    groupId = Object.keys(layout.groups)[0] ?? `files-group-${createUuid()}`;
  }
  if (!layout.groups[groupId]) layout = createEmptyFilesEditorLayout(groupId);
  return addFilesEditorViewToGroup(layout, groupId, {
    id: `files-view-${createUuid()}`,
    bufferId,
  });
}

export function reconcileOpenedBuffer(
  currentLayout: FilesEditorLayoutState,
  previousOpenIds: readonly string[],
  nextOpenIds: readonly string[],
  bufferId: string,
  mode: FilesOpenMode,
): FilesEditorLayoutState {
  let layout = currentLayout;
  const removedIds = previousOpenIds.filter((id) => !nextOpenIds.includes(id));
  const isNewBuffer = !previousOpenIds.includes(bufferId);

  // Replace the prior preview in-place so the focused split does not disappear
  // while its preview tab is replaced by another file.
  if (mode === "preview" && isNewBuffer && removedIds.length > 0) {
    const candidateViews = Object.values(layout.groups).flatMap((group) =>
      group.views
        .filter((view) => removedIds.includes(view.bufferId))
        .map((view) => ({ groupId: group.id, view })),
    );
    const replacement =
      candidateViews.find((candidate) => candidate.groupId === layout.focusedGroupId) ??
      candidateViews[0];
    if (replacement) {
      layout = replaceFilesEditorViewBuffer(layout, replacement.view.id, bufferId);
    }
  }

  for (const removedId of removedIds) {
    layout = removeFilesEditorViewsForBuffer(layout, removedId);
  }
  return addBufferToFocusedGroup(layout, bufferId);
}

export function createLayoutForOpenIds(
  openIds: readonly string[],
  activeId?: string,
): FilesEditorLayoutState {
  const groupId = `files-group-${createUuid()}`;
  const views = [...new Set(openIds)].map((bufferId) => ({
    id: `files-view-${createUuid()}`,
    bufferId,
  }));
  const activeViewId = views.find((view) => view.bufferId === activeId)?.id;
  return createFilesEditorLayoutWithViews(groupId, views, activeViewId);
}
