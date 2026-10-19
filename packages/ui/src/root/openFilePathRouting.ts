import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";

export function normalizeLocalFilePath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
  if (/^[A-Za-z]:\/$/.test(normalized) || normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

function pathComparisonKey(path: string): string {
  const normalized = normalizeLocalFilePath(path);
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function isFileInsideWorkspace(filePath: string, workspacePath: string): boolean {
  const file = pathComparisonKey(filePath);
  const root = pathComparisonKey(workspacePath);
  if (!file || !root) return false;
  if (file === root) return true;
  return root.endsWith("/") ? file.startsWith(root) : file.startsWith(`${root}/`);
}

function isLocalWorkspaceTab(tab: WindowTabState): tab is WorkspaceTabState {
  return isWorkspaceTab(tab) && !tab.remoteSessionId && !tab.workspaceIdentity && !tab.remoteTarget;
}

/** Pick the most specific already-open local workspace containing this file. */
export function findLocalWorkspaceTabForFile(
  filePath: string,
  tabs: readonly WindowTabState[],
): WorkspaceTabState | undefined {
  return tabs
    .filter(isLocalWorkspaceTab)
    .filter((tab) => isFileInsideWorkspace(filePath, tab.workspacePath))
    .sort((left, right) => right.workspacePath.length - left.workspacePath.length)[0];
}
