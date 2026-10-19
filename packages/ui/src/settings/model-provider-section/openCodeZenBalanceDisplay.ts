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

// 金额格式化只用于 Zen 余额；Go usage API 不提供金额。
// 见 openCodeCurrencyDisplay.ts（formatAmount / formatCurrencyAmount）。

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
