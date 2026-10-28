import type { IServiceAccessor } from "@zcode/services";
import { filesWorkspaceKey } from "@/files-workbench/filesEditorModel.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

export interface FilesWorkspaceServiceTab {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface FilesWorkspaceTarget {
  /** 身份 key：`workspaceIdentity?.trim() || workspacePath`。 */
  workspaceKey: string;
  /** 目标主机是否不是当前 Desktop 本机。 */
  remote: boolean;
  /** 与工作区身份匹配的标签、或工作区自身声明的远程 session。 */
  remoteSessionId?: string;
}

/**
 * 文件工作区目标的唯一本地 / 远程判定。
 *
 * 原生选路准入与实际文件服务解析都必须走这一条规则：按身份 key 匹配工作区标签，
 * 同时检查工作区自身和标签上的 remote session，不能根据路径长相判断目标主机。
 */
export function resolveFilesWorkspaceTarget(params: {
  workspace: FilesWorkspaceRef;
  workspaceTabs: readonly FilesWorkspaceServiceTab[];
}): FilesWorkspaceTarget {
  const workspaceKey = filesWorkspaceKey(params.workspace);
  const tab = params.workspaceTabs.find(
    (candidate) =>
      (candidate.workspaceIdentity?.trim() || candidate.workspacePath) === workspaceKey,
  );
  const remoteSessionId = params.workspace.workspaceRemoteSessionId ?? tab?.remoteSessionId;
  const remote = Boolean(
    params.workspace.workspaceIdentity?.trim() ||
    params.workspace.workspaceRemoteSessionId?.trim() ||
    tab?.workspaceIdentity?.trim() ||
    tab?.remoteSessionId?.trim(),
  );
  return { workspaceKey, remote, remoteSessionId };
}

/** 目标是否指向当前 Desktop 本机；供原生选路准入复用。 */
export function isFilesWorkspaceLocalTarget(params: {
  workspace: FilesWorkspaceRef;
  workspaceTabs: readonly FilesWorkspaceServiceTab[];
}): boolean {
  return !resolveFilesWorkspaceTarget(params).remote;
}

export function resolveFilesWorkspaceServices(params: {
  workspace: FilesWorkspaceRef;
  baseServices: IServiceAccessor;
  sessionsById: Record<string, { services?: IServiceAccessor }>;
  workspaceTabs: readonly FilesWorkspaceServiceTab[];
}): IServiceAccessor {
  const target = resolveFilesWorkspaceTarget(params);
  if (target.remote) {
    const remote = target.remoteSessionId
      ? params.sessionsById[target.remoteSessionId]?.services
      : undefined;
    if (!remote) {
      throw new Error("remote-workspace-disconnected");
    }
    return remote;
  }
  return params.baseServices;
}
