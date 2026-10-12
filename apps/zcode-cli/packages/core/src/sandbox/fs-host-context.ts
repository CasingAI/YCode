// 沙盒 FS 调用上下文：每一次方法调用现读 mode / cwd / 工作区根，不在实例创建时烤死。

import type { CollaborationMode, FileSystemPort, SessionId } from "@zcode/contracts";

export interface SandboxFsHostPaths {
  mode: CollaborationMode;
  workingDirectory: string;
  workspaceRoot: string;
}

export interface SandboxFsCallContext extends SandboxFsHostPaths {
  sessionId: SessionId;
  fileSystemPort: FileSystemPort;
}

export type SandboxFsHostLookup = () => SandboxFsCallContext | undefined;

export interface SandboxInstanceFsHost {
  sessionId: SessionId;
  resolve: SandboxFsHostLookup;
}
