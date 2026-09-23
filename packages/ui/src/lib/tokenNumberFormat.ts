export function formatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  // token 数值仍应走本地化 compact；中文展示万/亿，英文展示 K/M/B。
  // 之前为了修 Start Plan 的英文 long unit 误把所有 locale 都强制成 K/M/B。
  return new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

/**
 * 固定 K/M/B 口径的紧凑写法：用于容量/规格类数字（模型上下文窗口、上下文容量浮层的
 * used/size），不随中文 locale 变成「万/亿」——同一个 200K 窗口不该在两处显示成两种单位。
 * 消耗量类展示（用量统计、Start Plan 明细）继续用 formatCompactTokenNumber 的本地化口径，
 * 口径边界见 docs/specs/token-number-units.md。
 */
export function formatCompactTokenNumberWithMetricUnits(
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  return formatCompactTokenNumber("en-US", value, options);
}

export function formatModelContextWindowLabel(contextWindow: number, _locale = "en-US"): string {
  // 模型列表的容量 badge 是技术规格，不应随中文 locale 变成“万/亿”。
  return formatCompactTokenNumberWithMetricUnits(contextWindow);
}

export function formatContextUsageSummary({
  locale,
  percent,
  size,
  used,
}: {
  locale: string;
  percent: number;
  size: number;
  used: number;
}): string {
  const percentageFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  });
  return `${formatCompactTokenNumberWithMetricUnits(used)}/${formatCompactTokenNumberWithMetricUnits(
    size,
    {
      maximumFractionDigits: 0,
    },
  )} (${percentageFormatter.format(percent)})`;
}
