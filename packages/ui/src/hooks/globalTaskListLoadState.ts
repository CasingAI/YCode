/**
 * Blocking loading is reserved for a query with no completed read yet.
 * Revisions and manual refreshes for an already-read query revalidate in the background.
 */
export function isGlobalTaskListQueryLoading(params: {
  hasWorkspaceScope: boolean;
  currentQueryKey: string;
  settledQueryKey: string | null;
}): boolean {
  return params.hasWorkspaceScope && params.currentQueryKey !== params.settledQueryKey;
}
