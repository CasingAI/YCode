import { filesWorkspaceKey } from "@/files-workbench/filesEditorModel.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

export interface FilesExplorerWorkspaceOption {
  key: string;
  label: string;
  workspace: FilesWorkspaceRef;
}

export function toFilesWorkspaceRef(
  tab: Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity" | "remoteSessionId">,
): FilesWorkspaceRef {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { workspaceRemoteSessionId: tab.remoteSessionId } : {}),
  };
}

export function filesExplorerWorkspaceOptions(
  tabs: readonly WorkspaceTabState[],
): FilesExplorerWorkspaceOption[] {
  return tabs.map((tab) => {
    const workspace = toFilesWorkspaceRef(tab);
    return {
      key: filesWorkspaceKey(workspace),
      label: tab.label,
      workspace,
    };
  });
}

export function findFilesExplorerWorkspaceOption(
  options: readonly FilesExplorerWorkspaceOption[],
  key: string | undefined,
): FilesExplorerWorkspaceOption | undefined {
  if (!key) {
    return undefined;
  }
  return options.find((option) => option.key === key);
}

export function filesDefaultSaveDirectory(params: {
  selectedPath?: string;
  selectedIsDirectory?: boolean;
  workspaceRoot?: string;
}): string | undefined {
  if (params.selectedPath && params.selectedIsDirectory) {
    return params.selectedPath;
  }
  if (params.selectedPath) {
    const separatorIndex = Math.max(
      params.selectedPath.lastIndexOf("/"),
      params.selectedPath.lastIndexOf("\\"),
    );
    if (separatorIndex > 0) {
      return params.selectedPath.slice(0, separatorIndex);
    }
  }
  return params.workspaceRoot;
}
