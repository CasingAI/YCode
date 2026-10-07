/**
 * OpenRouter 余额的纯展示规则：USD 单币种，剩余额度 = 总额 - 已用。
 * 版式复用 DeepSeek 两行币种+金额（上行 USD，下行带符号金额），无进度条。
 */

/** 金额展示：保留两位小数，去掉多余的尾随 0；非有限数不展示。 */
export function formatOpenRouterAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  const fixed = value.toFixed(2);
  return fixed.replace(/\.?0+$/, "");
}

/**
 * 带货币符号的金额：USD → $74.75。符号与千分位交给 Intl 按当前界面语言处理。
 * 金额缺失时返回空串（不当作 0 展示）。
 */
export function formatOpenRouterCurrencyAmount(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return "";
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `USD ${formatOpenRouterAmount(value)}`;
  }
}
