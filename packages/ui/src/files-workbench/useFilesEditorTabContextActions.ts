import { useCallback, useMemo } from "react";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { filesWorkspaceKey, isFilesBufferDirty } from "@/files-workbench/filesEditorModel.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";
import type { FilesExplorerWorkspaceOption } from "@/files-workbench/filesExplorerWorkspace.js";

export function useFilesEditorTabContextActions({
  store,
  openBuffers,
  explorerOptions,
  closeViewsToRight,
  closeSavedViews,
  closeAllViews,
}: {
  store: FilesEditorStore;
  openBuffers: readonly FilesBuffer[];
  explorerOptions: readonly FilesExplorerWorkspaceOption[];
  closeViewsToRight: (viewId: string, groupId: string) => void;
  closeSavedViews: () => void;
  closeAllViews: () => void;
}) {
  const { copyAbsolutePath, copyRelativePath } = useFileContextActions();
  const explorerWorkspaceKeys = useMemo(
    () => new Set(explorerOptions.map((option) => option.key)),
    [explorerOptions],
  );
  const hasSavedBuffers = openBuffers.some((buffer) => !isFilesBufferDirty(buffer));

  const onCloseToRight = useCallback(
    (viewId: string, groupId: string) => closeViewsToRight(viewId, groupId),
    [closeViewsToRight],
  );
  const onCloseSaved = useCallback(() => closeSavedViews(), [closeSavedViews]);
  const onCloseAll = useCallback(() => closeAllViews(), [closeAllViews]);
  const onCopyPath = useCallback(
    (buffer: FilesBuffer, kind: "absolute" | "relative") => {
      if (!buffer.path) return;
      if (kind === "relative") {
        void copyRelativePath({
          path: buffer.path,
          relativePath: getWorkspaceFileRelativePath(buffer.workspace.workspacePath, buffer.path),
        });
      } else {
        void copyAbsolutePath({ path: buffer.path });
      }
    },
    [copyAbsolutePath, copyRelativePath],
  );
  const canRevealInFileTree = useCallback(
    (buffer: FilesBuffer) =>
      Boolean(buffer.path && explorerWorkspaceKeys.has(filesWorkspaceKey(buffer.workspace))),
    [explorerWorkspaceKeys],
  );
  const onRevealInFileTree = useCallback(
    (buffer: FilesBuffer) => {
      if (!buffer.path) return;
      const workspaceKey = filesWorkspaceKey(buffer.workspace);
      if (!explorerWorkspaceKeys.has(workspaceKey)) return;
      store.getState().setExplorerWorkspaceKey(workspaceKey);
      store.getState().setRevealPath(buffer.path);
    },
    [explorerWorkspaceKeys, store],
  );

  return {
    hasSavedBuffers,
    onCloseToRight,
    onCloseSaved,
    onCloseAll,
    onCopyPath,
    canRevealInFileTree,
    onRevealInFileTree,
  };
}
