/** OpenCode Zen 余额的美元/币种格式化，仅用于余额显示，不推算 Go 套餐金额。 */

/** 金额展示：保留两位小数，去掉多余的尾随 0；非有限数不展示。 */
export function formatAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  const fixed = value.toFixed(2);
  return fixed.replace(/\.?0+$/, "");
}

/**
 * 带货币符号的金额：符号与千分位交给 Intl 按当前界面语言处理。
 * 远端币种不是合法 ISO 4217 代码时回退到「代码 + 数字」。
 */
export function formatCurrencyAmount(
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
    return `${currency} ${formatAmount(value)}`;
  }
}
