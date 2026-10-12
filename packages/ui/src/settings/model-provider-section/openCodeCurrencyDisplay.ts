/**
 * OpenCode 金额的中性格式化：Go 三窗口与 Zen 余额共用同一口径。
 * 快照里的金额已由 services 层换算成美元（见 MICRO_CENTS_PER_USD），
 * 这里只做展示格式化，不做任何单位换算。
 */

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

/** Go 窗口的「已用 / 总额」：币种固定 USD（快照无币种字段），locale 取界面语言。 */
export function formatUsdCurrencyAmount(value: number | null, locale: string): string {
  return formatCurrencyAmount(value, "USD", locale);
}
