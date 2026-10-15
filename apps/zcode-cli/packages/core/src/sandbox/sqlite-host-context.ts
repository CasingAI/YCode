// 沙盒 SQLite 调用上下文：每一次方法调用现读 mode / cwd / 工作区根，不在实例创建时烤死。

import type { CollaborationMode, SessionId, SqliteReadPort } from "@zcode/contracts";

export interface SandboxSqliteHostPaths {
  mode: CollaborationMode;
  workingDirectory: string;
  workspaceRoot: string;
}

export interface SandboxSqliteCallContext extends SandboxSqliteHostPaths {
  sessionId: SessionId;
  sqliteReadPort: SqliteReadPort;
}

export type SandboxSqliteHostLookup = () => SandboxSqliteCallContext | undefined;

export interface SandboxInstanceSqliteHost {
  sessionId: SessionId;
  resolve: SandboxSqliteHostLookup;
}
