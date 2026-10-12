// ============================================================
// Sandbox 会话面：进程级实例表的唯一入口
// ============================================================
// 与 node-repl 的模块级 sessions Map 同构：key = sessionId，子代理
// 自己的 sessionId 自然隔离。deps（cliStorageRoot + fileSystemPort）
// 由 runtime-tools 在 executor 装配时注入（阶段2接线），缺席时实例仍可跑
// 内存态，只跳过磁盘落盘/灌回。FS 宿主按 sessionId 登记，父会话与子代理
// 互不覆盖。

import type { FileSystemPort, SessionId } from "@zcode/contracts";
import type { SandboxFsHostPaths } from "./fs-host-context.js";
import { SandboxInstanceTable } from "./instance-table.js";

const table = new SandboxInstanceTable();
const fsHostResolvers = new Map<SessionId, () => SandboxFsHostPaths | undefined>();

function lookupFsHost(sessionId: SessionId): SandboxFsHostPaths | undefined {
  return fsHostResolvers.get(sessionId)?.();
}

export function getSandboxInstanceTable(): SandboxInstanceTable {
  return table;
}

/** runtime 装配时注入落盘依赖与当前会话 FS 宿主（幂等：后一次覆盖前一次）。 */
export function configureSandboxTableDeps(deps: {
  cliStorageRoot?: string;
  fileSystemPort?: FileSystemPort;
  sessionId?: SessionId;
  resolveFsHost?: () => SandboxFsHostPaths | undefined;
}): void {
  if (deps.sessionId !== undefined) {
    if (deps.resolveFsHost) fsHostResolvers.set(deps.sessionId, deps.resolveFsHost);
    else fsHostResolvers.delete(deps.sessionId);
  }
  table.configureDeps({
    cliStorageRoot: deps.cliStorageRoot,
    fileSystemPort: deps.fileSystemPort,
    resolveFsHost: lookupFsHost,
  });
}

/** 测试与 session 关闭时释放（与 disposeNodeReplSession 同级）。 */
export function disposeSandboxSession(sessionId: SessionId): void {
  fsHostResolvers.delete(sessionId);
  table.dispose(sessionId);
}
