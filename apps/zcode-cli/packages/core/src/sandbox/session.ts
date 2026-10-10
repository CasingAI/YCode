// ============================================================
// Sandbox 会话面：进程级实例表的唯一入口
// ============================================================
// 与 node-repl 的模块级 sessions Map 同构：key = sessionId，子代理
// 自己的 sessionId 自然隔离。deps（cliStorageRoot + fileSystemPort）
// 由 runtime-tools 在 executor 装配时注入（阶段2接线），缺席时实例仍可跑
// 内存态，只跳过磁盘落盘/灌回。

import type { FileSystemPort } from "@zcode/contracts";
import { SandboxInstanceTable } from "./instance-table.js";

const table = new SandboxInstanceTable();

export function getSandboxInstanceTable(): SandboxInstanceTable {
  return table;
}

/** runtime 装配时注入落盘依赖（幂等：后一次覆盖前一次）。 */
export function configureSandboxTableDeps(deps: {
  cliStorageRoot?: string;
  fileSystemPort?: FileSystemPort;
}): void {
  table.configureDeps(deps);
}

/** 测试与 session 关闭时释放（与 disposeNodeReplSession 同级）。 */
export function disposeSandboxSession(sessionId: import("@zcode/contracts").SessionId): void {
  table.dispose(sessionId);
}
