import type { DeepSeekBalanceInfo } from "@zcode/shared";

/**
 * 卡片里单个币种区块的展示行：只有币种与金额两行，没有上限也没有进度条
 * （DeepSeek 不给总额，算不出「剩余/总量」）。
 */
export interface DeepSeekBalanceLine {
  currency: string;
  /** 账户总余额；远端没给时为 null（不当作 0 展示）。 */
  total: number | null;
}

/**
 * 主币种排在首位：远端可能同时返回 CNY 与 USD，CNY 是国内账号的默认结算币种，
 * 放首位与「默认余额」的直觉一致；其余币种保持远端顺序（远端顺序本身稳定，不另做排序）。
 */
const PRIMARY_CURRENCY = "CNY";

/** 金额展示：保留远端精度上限的两位小数，去掉多余的尾随 0；非有限数不展示。 */
export function formatDeepSeekAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  const fixed = value.toFixed(2);
  return fixed.replace(/\.?0+$/, "");
}

/**
 * 快照余额 → 展示行。
 * - 缺 currency 的条目直接丢弃（没有币种无法表达金额）；
 * - 三个远端金额全为 null 的条目丢弃，避免渲染出空壳区块（金额本身缺失但有构成数据时，
 *   仍要显示这一行，只是不出数字——「有这条余额」比「有数字」更重要）。
 */
export function toDeepSeekBalanceLines(
  balances: readonly DeepSeekBalanceInfo[],
): DeepSeekBalanceLine[] {
  const lines: DeepSeekBalanceLine[] = [];
  for (const balance of balances) {
    const currency = balance.currency.trim();
    if (currency === "") continue;
    if (
      balance.totalBalance === null &&
      balance.grantedBalance === null &&
      balance.toppedUpBalance === null
    ) {
      continue;
    }
    lines.push({ currency, total: balance.totalBalance });
  }
  return lines.sort((left, right) => {
    if (left.currency === right.currency) return 0;
    if (left.currency === PRIMARY_CURRENCY) return -1;
    if (right.currency === PRIMARY_CURRENCY) return 1;
    return 0;
  });
}
