/** 统一的双线实时趋势图，可用于紧凑总览与展开的诊断图。 */
function makeLine(
  values: readonly number[],
  width: number,
  height: number,
  maxValue: number,
): string {
  if (values.length === 0) return "";
  const padding = 8;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  return values
    .map((value, index) => {
      const x =
        padding + (values.length <= 1 ? plotWidth / 2 : (index / (values.length - 1)) * plotWidth);
      const y = height - padding - (Math.max(0, value) / maxValue) * plotHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function TrendChart({
  title,
  firstLabel,
  secondLabel,
  firstValues,
  secondValues,
  firstValueFormatter,
  secondValueFormatter,
  currentFirstValue,
  currentSecondValue,
  compact = false,
}: {
  title: string;
  firstLabel: string;
  secondLabel?: string;
  firstValues: readonly number[];
  secondValues?: readonly number[];
  firstValueFormatter: (value: number) => string;
  secondValueFormatter?: (value: number) => string;
  currentFirstValue?: number;
  currentSecondValue?: number;
  compact?: boolean;
}) {
  const width = 720;
  const height = compact ? 90 : 172;
  const maxValue = Math.max(1, ...firstValues, ...(secondValues ?? []));
  const firstPath = makeLine(firstValues, width, height, maxValue);
  const secondPath = secondValues ? makeLine(secondValues, width, height, maxValue) : "";
  return (
    <section
      className={
        compact ? "min-w-0 px-3 py-2" : "min-w-0 rounded-xl border border-border bg-card p-3"
      }
    >
      {!compact ? <div className="mb-2 text-ui-sm font-medium">{title}</div> : null}
      <svg
        className={`block w-full overflow-visible text-primary ${compact ? "h-[90px]" : "h-32"}`}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title}
        preserveAspectRatio="none"
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1="8"
            x2={width - 8}
            y1={height - 8 - fraction * (height - 16)}
            y2={height - 8 - fraction * (height - 16)}
            stroke="currentColor"
            strokeOpacity="0.12"
            strokeWidth="1"
          />
        ))}
        {firstPath ? (
          <path
            d={firstPath}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {secondPath ? (
          <path
            d={secondPath}
            fill="none"
            stroke="var(--color-warning, #d97706)"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-ui-xs text-foreground-subtle">
        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary" />
          {firstLabel}:{" "}
          {firstValueFormatter(currentFirstValue ?? firstValues[firstValues.length - 1] ?? 0)}
        </span>
        {secondLabel && secondValues && secondValueFormatter ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-amber-600" />
            {secondLabel}:{" "}
            {secondValueFormatter(currentSecondValue ?? secondValues[secondValues.length - 1] ?? 0)}
          </span>
        ) : null}
      </div>
    </section>
  );
}
