// 实例表宿主上下文装配：FS / fetch / sqlite 三路 resolve 闭包的纯函数形态。
// 从 instance-table.ts 抽出，避免该文件超行数上限；无状态、无 IO。

import type { FileSystemPort, HttpClientPort, SessionId, SqliteReadPort } from "@zcode/contracts";
import type { SandboxFetchCallContext, SandboxInstanceFetchHost } from "./fetch-host-context.js";
import type {
  SandboxFsCallContext,
  SandboxFsHostPaths,
  SandboxInstanceFsHost,
} from "./fs-host-context.js";
import type {
  SandboxSqliteCallContext,
  SandboxSqliteHostPaths,
  SandboxInstanceSqliteHost,
} from "./sqlite-host-context.js";

export function resolveSandboxFsHostContext(input: {
  sessionId: SessionId;
  fileSystemPort?: FileSystemPort;
  resolveFsHost?: (sessionId: SessionId) => SandboxFsHostPaths | undefined;
}): SandboxFsCallContext | undefined {
  const paths = input.resolveFsHost?.(input.sessionId);
  if (!input.fileSystemPort || !paths) return undefined;
  return {
    sessionId: input.sessionId,
    fileSystemPort: input.fileSystemPort,
    mode: paths.mode,
    workingDirectory: paths.workingDirectory,
    workspaceRoot: paths.workspaceRoot,
  };
}

export function resolveSandboxFetchHostContext(input: {
  sessionId: SessionId;
  resolveFetchHost?: (sessionId: SessionId) => HttpClientPort | undefined;
}): SandboxFetchCallContext | undefined {
  const port = input.resolveFetchHost?.(input.sessionId);
  if (!port) return undefined;
  return { sessionId: input.sessionId, httpClientPort: port };
}

export function resolveSandboxSqliteHostContext(input: {
  sessionId: SessionId;
  sqliteReadPort?: SqliteReadPort;
  resolveFsHost?: (sessionId: SessionId) => SandboxFsHostPaths | undefined;
  resolveSqliteHost?: (sessionId: SessionId) => SandboxSqliteHostPaths | undefined;
}): SandboxSqliteCallContext | undefined {
  const paths =
    input.resolveSqliteHost?.(input.sessionId) ?? input.resolveFsHost?.(input.sessionId);
  if (!input.sqliteReadPort || !paths) return undefined;
  return {
    sessionId: input.sessionId,
    sqliteReadPort: input.sqliteReadPort,
    mode: paths.mode,
    workingDirectory: paths.workingDirectory,
    workspaceRoot: paths.workspaceRoot,
  };
}

export interface SandboxTableHostDeps {
  fileSystemPort?: FileSystemPort;
  sqliteReadPort?: SqliteReadPort;
  resolveFsHost?: (sessionId: SessionId) => SandboxFsHostPaths | undefined;
  resolveFetchHost?: (sessionId: SessionId) => HttpClientPort | undefined;
  resolveSqliteHost?: (sessionId: SessionId) => SandboxSqliteHostPaths | undefined;
}

/** 三路宿主装配成 SandboxInstance.create 的位置参数；instance-table 只做委托。 */
export function buildSandboxInstanceHosts(
  sessionId: SessionId,
  deps: SandboxTableHostDeps,
): [SandboxInstanceFsHost, SandboxInstanceFetchHost, SandboxInstanceSqliteHost] {
  return [
    {
      sessionId,
      resolve: () =>
        resolveSandboxFsHostContext({
          sessionId,
          fileSystemPort: deps.fileSystemPort,
          resolveFsHost: deps.resolveFsHost,
        }),
    },
    {
      sessionId,
      resolve: () =>
        resolveSandboxFetchHostContext({
          sessionId,
          resolveFetchHost: deps.resolveFetchHost,
        }),
    },
    {
      sessionId,
      resolve: () =>
        resolveSandboxSqliteHostContext({
          sessionId,
          sqliteReadPort: deps.sqliteReadPort,
          resolveFsHost: deps.resolveFsHost,
          resolveSqliteHost: deps.resolveSqliteHost,
        }),
    },
  ];
}
