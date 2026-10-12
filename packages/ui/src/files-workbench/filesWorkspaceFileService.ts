import type { IServiceAccessor } from "@zcode/services";
import { filesWorkspaceKey } from "@/files-workbench/filesEditorModel.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

export interface FilesWorkspaceServiceTab {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export function resolveFilesWorkspaceServices(params: {
  workspace: FilesWorkspaceRef;
  baseServices: IServiceAccessor;
  sessionsById: Record<string, { services?: IServiceAccessor }>;
  workspaceTabs: readonly FilesWorkspaceServiceTab[];
}): IServiceAccessor {
  const key = filesWorkspaceKey(params.workspace);
  const tab = params.workspaceTabs.find(
    (candidate) => (candidate.workspaceIdentity?.trim() || candidate.workspacePath) === key,
  );
  const sessionId = params.workspace.workspaceRemoteSessionId ?? tab?.remoteSessionId;
  const isRemote = Boolean(
    params.workspace.workspaceIdentity?.trim() ||
      params.workspace.workspaceRemoteSessionId?.trim() ||
      tab?.workspaceIdentity?.trim() ||
      tab?.remoteSessionId?.trim(),
  );
  if (isRemote) {
    const remote = sessionId ? params.sessionsById[sessionId]?.services : undefined;
    if (!remote) {
      throw new Error("remote-workspace-disconnected");
    }
    return remote;
  }
  return params.baseServices;
}
