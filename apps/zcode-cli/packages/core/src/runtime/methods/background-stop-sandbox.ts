// ============================================================
// 沙盒的后台停止分支（runtime.stopBackgroundTask 的 local_sandbox 分派）
// ============================================================
// 沙盒后台没有「停这一条 JS」：停止从不打断正在跑的 JS（spec「停止与重置」），
// 可靠的整段停法只有销毁实例（控制台重置按钮 / 工具 reset 参数）。
// 单独成模块是为了限制 background.ts 的规模（该文件已超行），与
// background-stop-dynamic-workflow.ts 同形；background.ts 侧只保留
// 一个 import 与一行分派。

import type { AgentRuntimeInternal } from "../internal.js";
import type {
  RuntimeBackgroundStopResult,
  TypedRuntimeBackgroundStopTarget,
} from "./background-stop-types.js";

/**
 * 停止一个沙盒后台任务：显式拒绝，不打断 JS。
 * 原因与修复依据：spec「停止与重置」要求停止从不打断正在跑的 JS；
 * 显式分支钉死该不变量，避免后人给 stopBackgroundTask 加默认放行逻辑时
 * 误杀 worker。想解脱只能重置实例（销毁整份实例，后台 ID 全失效）。
 */
export async function stopSandboxBackgroundTask(
  this: AgentRuntimeInternal,
  target: TypedRuntimeBackgroundStopTarget,
  unsupported: (target: TypedRuntimeBackgroundStopTarget) => RuntimeBackgroundStopResult,
): Promise<RuntimeBackgroundStopResult> {
  return unsupported(target);
}
