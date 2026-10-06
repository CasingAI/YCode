// ============================================================
// History 工具家族共享声明（HistoryList / HistoryRead / HistorySearch）
// ============================================================
// 三个 handler 的权限、预算、超时同档：全部只读免审批，对齐 ReadSessionContext
// 的低风险只读位。见 docs/specs/session-history-tools.md。

import type { ToolPermissionSpec } from "@zcode/contracts";

// 覆盖默认分页（24000 字符，CJK 下约 72KB）并给 maxChars=0 的全文读取留出
// resultBudget 截断保护；超出部分由 resultBudget 按 head 预览截断。
export const HISTORY_TOOL_MAX_OUTPUT_BYTES = 400_000;
// 扫描本地 SQLite 的只读查询；大存档的 search 全量扫描也应在分钟级内完成。
export const HISTORY_TOOL_TIMEOUT_MS = 120_000;

export function historyToolPermission(): ToolPermissionSpec {
  return {
    permission: "session.history.read",
    reason: "History tools only read persisted session history through SessionStorePort",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  };
}

export function historyErrorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
