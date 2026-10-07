import type { MiniMaxQuotaWindow } from "@zcode/shared";

/**
 * MiniMax 额度窗口的展示行：剩余百分比 + 重置时间，没有绝对值
 * （远端 `*_count` 语义反转，解析层直接忽略）。
 */
export interface MiniMaxQuotaLine {
  key: MiniMaxQuotaWindow["key"];
  /** 剩余百分比 0–100（周窗口可能因 boost 超过 100，已钳到 200）。 */
  remainingPercent: number;
  /** 已用百分比 0–100（= 100 - remaining，用于 UsageQuotaLimit 投影）。 */
  usagePercent: number;
  /** ISO 重置时间；远端缺失时为 null。 */
  resetAt: string | null;
  /** true = 不在套餐内（status === 3），不得渲染百分比。 */
  notInPlan: boolean;
}

/** status === 3 表示该模型不在套餐内（官方 CLI issue #173 实证）。 */
export function isMiniMaxWindowNotInPlan(status: number | null): boolean {
  return status === 3;
}

/**
 * 快照窗口 → 展示行。status === 3 的窗口保留行结构但标记 notInPlan，
 * 由展示端决定显示「不在套餐内」而不渲染百分比。
 */
export function toMiniMaxQuotaLines(windows: readonly MiniMaxQuotaWindow[]): MiniMaxQuotaLine[] {
  return windows.map((window) => ({
    key: window.key,
    remainingPercent: window.remainingPercent,
    usagePercent: Math.max(0, Math.min(100, 100 - window.remainingPercent)),
    resetAt: window.resetAt,
    notInPlan: isMiniMaxWindowNotInPlan(window.status),
  }));
}

/** 剩余百分比展示：≥10 取整，否则保留 1 位小数（与 OpenCode 浮层口径一致）。 */
export function formatMiniMaxRemainingPercent(value: number, locale: string): string {
  return `${new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value)}%`;
}
