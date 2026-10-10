// ============================================================
// Sandbox 控制台用户 eval（阶段8可交互面）
// ============================================================
// 与模型工具调用进同一活实例（同一条执行路径 evalWithSource，不另开第二条
// 执行态）：执行行来源记 user（样式可区分），不写 transcript，不包新实例提示。
// 空代码直接参数错误，不执行不追加行。规则见 docs/specs/sandbox-system-tool.md。

import type { SandboxEvalOptions, SandboxEvalResult, SessionId } from "@zcode/contracts";
import type { SandboxInstanceTable } from "./instance-table.js";

/** 用户 eval 的默认超时（与模型工具调用的默认 120s 对齐，不接受模型改参）。 */
export const SANDBOX_USER_EVAL_TIMEOUT_MS = 120_000;

export async function evalSandboxForUser(
  table: SandboxInstanceTable,
  sessionId: SessionId,
  code: string,
  options?: SandboxEvalOptions,
): Promise<{
  result: SandboxEvalResult;
  instanceAlive: boolean;
  isFirstResultOnNewInstance: boolean;
}> {
  const trimmed = code.trim();
  if (!trimmed) {
    return {
      result: {
        kind: "failed",
        error: { code: "sandbox_invalid_input", message: "输入为空，不执行" },
        consoleLines: [],
        consoleTruncated: false,
      },
      instanceAlive: table.hasLiveInstance(sessionId),
      isFirstResultOnNewInstance: false,
    };
  }
  return table.evalWithSource(
    { sessionId, code: trimmed, timeoutMs: SANDBOX_USER_EVAL_TIMEOUT_MS },
    "user",
    options,
  );
}
