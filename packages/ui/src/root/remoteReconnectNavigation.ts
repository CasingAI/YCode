export interface RemoteReconnectNavigationIntent {
  activeTabId: string | null;
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  activeTaskId: string | null;
  draftFocusVersion: number;
}

export function isRemoteReconnectNavigationIntentCurrent(
  expected: RemoteReconnectNavigationIntent,
  current: RemoteReconnectNavigationIntent,
): boolean {
  return (
    expected.activeTabId === current.activeTabId &&
    expected.activeWorkspacePath === current.activeWorkspacePath &&
    expected.activeWorkspaceIdentity === current.activeWorkspaceIdentity &&
    expected.activeTaskId === current.activeTaskId &&
    expected.draftFocusVersion === current.draftFocusVersion
  );
}

export function shouldActivateReconnectedWorkspace(
  activateWorkspaceAfterReconnect: boolean,
  isNavigationStillCurrent?: () => boolean,
): boolean {
  return activateWorkspaceAfterReconnect && (isNavigationStillCurrent?.() ?? true);
}
