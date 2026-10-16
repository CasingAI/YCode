import {
  REMOTE_AGENT_BUNDLE_NAME,
  REMOTE_AGENT_HISTORY_WORKER_NAME,
  REMOTE_AGENT_SQLITE_WORKER_NAME,
} from "@zcode/server/remote/zcodeAgentBundleWrapper.js";

export function buildRemoteAgentRequiredAssetPaths(remoteProviderDir: string): string[] {
  return [
    `${remoteProviderDir}/${REMOTE_AGENT_BUNDLE_NAME}`,
    `${remoteProviderDir}/${REMOTE_AGENT_HISTORY_WORKER_NAME}`,
    `${remoteProviderDir}/${REMOTE_AGENT_SQLITE_WORKER_NAME}`,
  ];
}

export async function findMissingRemoteAgentRequiredAssetPaths(
  remoteProviderDir: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const path of buildRemoteAgentRequiredAssetPaths(remoteProviderDir)) {
    if (!(await exists(path))) missingPaths.push(path);
  }
  return missingPaths;
}
