import type { OpenCodeZenBalanceInfo } from "@zcode/shared";

/**
 * Zen 余额的展示行：币种 + 金额两行，无进度条（与 DeepSeek 余额版式一致）。
 * billing/status 币种缺失时默认为 USD（见 mapBillingStatusBalance）。
 */
export interface OpenCodeZenBalanceLine {
  currency: string;
  /** 账户余额；远端没给时为 null（不当作 0 展示）。 */
  amount: number | null;
}

/** 金额展示：保留两位小数，去掉多余的尾随 0；非有限数不展示。 */
export function formatOpenCodeZenAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  const fixed = value.toFixed(2);
  return fixed.replace(/\.?0+$/, "");
}

/**
 * 带货币符号的金额：符号与千分位交给 Intl 按当前界面语言处理。
 * 远端币种不是合法 ISO 4217 代码时回退到「代码 + 数字」。
 */
export function formatOpenCodeZenCurrencyAmount(
  value: number | null,
  currency: string,
  locale: string,
): string {
  if (value === null || !Number.isFinite(value)) return "";
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${formatOpenCodeZenAmount(value)}`;
  }
}

/**
 * 快照余额 → 展示行。缺 currency 的条目直接丢弃；金额为 null 的条目保留行结构
 * （「有这条余额」比「有数字」更重要，只是不出数字）。
 */
export function toOpenCodeZenBalanceLines(
  balances: readonly OpenCodeZenBalanceInfo[],
): OpenCodeZenBalanceLine[] {
  const lines: OpenCodeZenBalanceLine[] = [];
  for (const balance of balances) {
    const currency = balance.currency.trim();
    if (currency === "") continue;
    lines.push({ currency, amount: balance.amount });
  }
  return lines;
}
