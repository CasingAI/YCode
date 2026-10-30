import type { CommandCodeQuotaCredits, CommandCodeQuotaWindow } from "@zcode/shared";

/**
 * Command Code 额度窗口的展示行：已用百分比 + 金额明细 + 重置时间。
 * 窗口是美元计价（used/cap 为金额），百分比 = used/cap×100（解析层已钳 0–100）。
 */
export interface CommandCodeQuotaLine {
  key: CommandCodeQuotaWindow["key"];
  used: number;
  cap: number;
  /** 已用百分比 0–100（用于 UsageQuotaLimit 投影）。 */
  usagePercent: number;
  /** ISO 重置时间；远端缺失时为 null。 */
  resetAt: string | null;
  /** true = 已触顶（远端 exceeded），不得渲染进度条。 */
  exceeded: boolean;
}

/** 快照窗口 → 展示行（结构原样透传，收敛在一个可测的纯函数里）。 */
export function toCommandCodeQuotaLines(
  windows: readonly CommandCodeQuotaWindow[],
): CommandCodeQuotaLine[] {
  return windows.map((window) => ({
    key: window.key,
    used: window.used,
    cap: window.cap,
    usagePercent: window.usagePercent,
    resetAt: window.resetAt,
    exceeded: window.exceeded,
  }));
}

/** 金额展示：美元、最多两位小数（$6.4 → $6.40，$0 → $0.00）。 */
export function formatCommandCodeMoney(value: number, locale: string): string {
  return new Intl.NumberFormat(locale || undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** 窗口明细：已用 $X / 上限 $Y。 */
export function formatCommandCodeWindowDetail(line: CommandCodeQuotaLine, locale: string): string {
  return `${formatCommandCodeMoney(line.used, locale)} / ${formatCommandCodeMoney(line.cap, locale)}`;
}

/**
 * 余额行合计：只加已上报项，三项全 null（远端未上报 credits）返回 null，
 * 展示端不渲染该行——缺失 ≠ 0，绝不出现假 0 余额。
 */
export function sumCommandCodeCredits(credits: CommandCodeQuotaCredits | null): number | null {
  if (!credits) return null;
  const values = [credits.monthly, credits.purchased, credits.free].filter(
    (value): value is number => value !== null,
  );
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}
