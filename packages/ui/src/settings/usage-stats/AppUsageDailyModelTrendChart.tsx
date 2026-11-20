import { type ComponentProps, useCallback, useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { AppUsageSnapshot } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  UsageEmptyState,
  formatCompactTokenUsage,
  resolveModelLabel,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { getAppUsageModelChartColor } from "@/settings/usage-stats/appUsageChartPalette.js";
import {
  type AppUsageChartMode,
  type DailyModelChartRow,
  buildAppUsageDailyModelChartViewModel,
} from "@/settings/usage-stats/appUsageDailyModelChartViewModel.js";

// XAxis 首尾刻度以绘图区边界为中心向两侧延伸，原 8px margin 小于日期文本半宽，
// SVG 会裁掉首尾文字；左右保留 24px 安全区，让桌面端与手机 Web 端都能完整显示短日期。
export const APP_USAGE_TREND_CHART_MARGIN = {
  top: 8,
  right: 24,
  left: 24,
} as const;

const APP_USAGE_CHART_MODES: AppUsageChartMode[] = ["byModel", "total"];

type ChartTooltipContentProps = ComponentProps<typeof ChartTooltipContent>;

export function filterDailyModelTooltipPayload<T extends { value?: unknown }>(
  payload: readonly T[] | undefined,
): T[] {
  // Recharts 的多序列 tooltip payload 会包含当天所有模型；
  // 0 用量模型没有可见趋势点，继续展示会误导用户以为 hover 到了有效用量。
  return (payload ?? []).filter((item) => {
    const value = typeof item.value === "number" ? item.value : Number(item.value);
    return Number.isFinite(value) && value > 0;
  });
}

export function resolveDailyModelTooltipTokenParts(
  locale: string,
  value: unknown,
  tokenUnit: string,
): { number: string; unit: string } {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return { number: String(value), unit: "" };
  }
  return {
    number: formatCompactTokenUsage(locale, numericValue),
    unit: tokenUnit,
  };
}

function shouldShowDailyChartAxisLabel(index: number, total: number): boolean {
  if (total <= 14) {
    return true;
  }
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

function DailyModelChartTooltipContent(props: ChartTooltipContentProps) {
  const filteredPayload = useMemo(
    () => filterDailyModelTooltipPayload(props.payload),
    [props.payload],
  );

  if (!props.active || filteredPayload.length === 0) {
    return null;
  }

  return <ChartTooltipContent {...props} payload={filteredPayload} />;
}

// 总量模式只有一条折线，日期与合计已在标题里给全；
// 再列单行明细会原样重复标题数字，因此只渲染标题。
function DailyTotalTooltipContent({ active, payload, labelFormatter }: ChartTooltipContentProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-ui-sm/relaxed shadow-xl">
      <div className="font-medium">{labelFormatter?.(null, payload)}</div>
    </div>
  );
}

export function AppUsageDailyModelTrendChart({
  snapshot,
  mode,
  onModeChange,
}: {
  snapshot: AppUsageSnapshot;
  mode: AppUsageChartMode;
  onModeChange: (mode: AppUsageChartMode) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const { models, modelKeys, chartConfig, chartData, maxModelTokens, maxTotalTokens } = useMemo(
    // Recharts 3.8 会把 data / legend / graphical item props 写入内部 store。
    // 这里稳定派生数组和配置对象，避免父组件重渲染时因引用变化反复触发内部 dispatch。
    () => buildAppUsageDailyModelChartViewModel({ intl, locale, snapshot }),
    [intl, locale, snapshot],
  );
  const totalChartConfig = useMemo<ChartConfig>(() => ({}), []);
  const shouldShowAxisLabel = useCallback(
    (_value: string, index: number) =>
      shouldShowDailyChartAxisLabel(index, chartData.length) ? _value : "",
    [chartData.length],
  );
  const formatTooltipLabel = useCallback(
    (_: unknown, payload: readonly { payload?: unknown }[]) => {
      const row = payload[0]?.payload as DailyModelChartRow | undefined;
      const total = typeof row?.total === "number" ? row.total : 0;
      return `${row?.tooltipLabel ?? ""} - ${formatCompactTokenUsage(locale, total)} ${intl.formatMessage(
        {
          id: "settings.usage.tokenUnit",
        },
      )}`;
    },
    [intl, locale],
  );
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  const formatTooltipItem = useCallback(
    (value: unknown, name: unknown, item: { color?: string }) => {
      const itemName = String(name);
      const label = chartConfig[itemName]?.label ?? itemName;
      const color = item.color ?? `var(--color-${itemName})`;
      const tokenValue = resolveDailyModelTooltipTokenParts(locale, value, tokenUnit);
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: color }}
          />
          <div className="flex flex-1 items-center justify-between gap-3">
            <span className="text-foreground-subtle">{label}</span>
            <span className="flex items-baseline gap-1 text-foreground">
              <span className="font-mono font-medium tabular-nums">{tokenValue.number}</span>
              {tokenValue.unit ? (
                <span className="text-foreground-subtle">{tokenValue.unit}</span>
              ) : null}
            </span>
          </div>
        </>
      );
    },
    [chartConfig, locale, tokenUnit],
  );
  const modelTooltipContent = useMemo(
    () => (
      <DailyModelChartTooltipContent
        indicator="line"
        labelFormatter={formatTooltipLabel}
        formatter={formatTooltipItem}
      />
    ),
    [formatTooltipItem, formatTooltipLabel],
  );
  const totalTooltipContent = useMemo(
    () => <DailyTotalTooltipContent indicator="line" labelFormatter={formatTooltipLabel} />,
    [formatTooltipLabel],
  );
  // 模式各自的空态判断：分模型看单模型峰值，总量看全天合计峰值。
  const isChartEmpty = mode === "total" ? maxTotalTokens <= 0 : maxModelTokens <= 0;

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.dailyChartTitle" })}
        </h3>
        <Tabs
          value={mode}
          onValueChange={(value) => onModeChange(value as AppUsageChartMode)}
          className="shrink-0"
        >
          <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
            {APP_USAGE_CHART_MODES.map((option) => (
              <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
                {intl.formatMessage({ id: `settings.usage.chartMode.${option}` })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {isChartEmpty ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      ) : mode === "total" ? (
        <div className="px-3 py-3">
          <ChartContainer config={totalChartConfig} className="h-60 w-full">
            <LineChart accessibilityLayer data={chartData} margin={APP_USAGE_TREND_CHART_MARGIN}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                interval={0}
                minTickGap={0}
                tickMargin={8}
                tickFormatter={shouldShowAxisLabel}
              />
              <YAxis hide domain={[0, maxTotalTokens]} />
              <ChartTooltip cursor={false} content={totalTooltipContent} />
              <Line
                dataKey="total"
                type="monotone"
                stroke={getAppUsageModelChartColor(0)}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ChartContainer>
        </div>
      ) : (
        <div className="px-3 py-3">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2" role="list">
            {models.map((model, index) => (
              <div
                key={model.modelId ?? "__unknown__"}
                className="flex min-w-0 items-center gap-2 text-ui-sm"
                role="listitem"
              >
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: getAppUsageModelChartColor(index),
                  }}
                />
                <span className="truncate text-foreground-subtle">
                  {resolveModelLabel(intl, model.modelId)}
                </span>
              </div>
            ))}
          </div>
          <ChartContainer config={chartConfig} className="h-60 w-full">
            <LineChart accessibilityLayer data={chartData} margin={APP_USAGE_TREND_CHART_MARGIN}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                interval={0}
                minTickGap={0}
                tickMargin={8}
                tickFormatter={shouldShowAxisLabel}
              />
              <YAxis hide domain={[0, maxModelTokens]} />
              <ChartTooltip cursor={false} content={modelTooltipContent} />
              {modelKeys.map((model) => (
                <Line
                  key={model.key}
                  dataKey={model.key}
                  type="monotone"
                  stroke={`var(--color-${model.key})`}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ChartContainer>
        </div>
      )}
    </section>
  );
}
