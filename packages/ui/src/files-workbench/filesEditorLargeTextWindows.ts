import { filesWorkspaceKey, isFilesLargeTextBuffer } from "@/files-workbench/filesEditorModel.js";
import { disposeFilesLargeTextWindow } from "@/files-workbench/filesLargeTextWindowStore.js";
import { filesLargeTextWindowOwner } from "@/files-workbench/filesLargeTextWindowSeed.js";
import type { FilesBuffer, FilesEditorState } from "@/files-workbench/filesEditorTypes.js";

function sameLargeTextOwner(left: FilesBuffer, right: FilesBuffer): boolean {
  return (
    left.path === right.path &&
    filesWorkspaceKey(left.workspace) === filesWorkspaceKey(right.workspace) &&
    (left.workspace.workspaceRemoteSessionId?.trim() ?? "") ===
      (right.workspace.workspaceRemoteSessionId?.trim() ?? "")
  );
}

/** 缓冲删除、large→text/preview、改名或身份变化时释放 rangeStore 的 owner entry。 */
export function disposeStaleLargeTextWindows(
  state: FilesEditorState,
  previous: FilesEditorState,
): void {
  if (state.buffers === previous.buffers) return;
  for (const buffer of previous.buffers) {
    if (!isFilesLargeTextBuffer(buffer)) continue;
    const next = state.buffers.find((candidate) => candidate.id === buffer.id);
    if (!next || !isFilesLargeTextBuffer(next) || !sameLargeTextOwner(buffer, next)) {
      disposeFilesLargeTextWindow(buffer.id, filesLargeTextWindowOwner(buffer));
    }
  }
}
