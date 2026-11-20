import type { AppUsageSnapshot } from "@zcode/shared";
import type { ChartConfig } from "@/components/ui/chart.js";
import { getAppUsageModelChartColor } from "@/settings/usage-stats/appUsageChartPalette.js";
import { formatDay, resolveModelLabel } from "@/settings/usage-stats/usageStatsUiParts.js";

export type AppUsageChartMode = "byModel" | "total";

export interface UsageIntl {
  formatMessage: (descriptor: { id: string }) => string;
}

export type DailyModelChartRow = {
  label: string;
  tooltipLabel: string;
  total: number;
} & Record<string, number | string>;

export interface ModelChartKey {
  modelId: string | null;
  key: string;
  color: string;
  label: string;
}

function createEmptyChartRow(label: string, tooltipLabel: string, modelKeys: ModelChartKey[]) {
  const row: DailyModelChartRow = {
    label,
    tooltipLabel,
    total: 0,
  };

  for (const model of modelKeys) {
    row[model.key] = 0;
  }

  return row;
}

function buildDailyModelChartData({
  snapshot,
  locale,
  modelKeys,
  modelKeyById,
}: {
  snapshot: AppUsageSnapshot;
  locale: string;
  modelKeys: ModelChartKey[];
  modelKeyById: Map<string, string>;
}): DailyModelChartRow[] {
  const rows = new Map<string, DailyModelChartRow>();

  // App Usage 的 30d 协议结果已经是每日序列，旧 all 分桶残留把
  // 30 天按周聚合成约 5 个点，导致“最近 30 天”没有连续每日趋势。
  for (const day of snapshot.dailyModelUsage) {
    const label = formatDay(locale, day.date);
    const row = rows.get(day.date) ?? createEmptyChartRow(label, label, modelKeys);

    for (const model of day.models) {
      const key = modelKeyById.get(model.modelId ?? "__unknown__");
      if (key) {
        row[key] = Number(row[key] ?? 0) + model.totalTokens;
      }
      row.total += model.totalTokens;
    }

    rows.set(day.date, row);
  }

  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

export function buildAppUsageDailyModelChartViewModel({
  intl,
  locale,
  snapshot,
}: {
  intl: UsageIntl;
  locale: string;
  snapshot: AppUsageSnapshot;
}) {
  // 全量绘制 tokens > 0 的模型：旧实现只画总量前 6 名，当天活跃但
  // 累计排名未进前 6 的模型整条不可见，tooltip 标题（全天合计）与
  // 可见行合计对不上。0 用量模型不画线、不进图例。
  const models = snapshot.models.filter((model) => model.totalTokens > 0);
  const modelKeys = models.map((model, index) => ({
    modelId: model.modelId,
    key: `model${index}`,
    color: getAppUsageModelChartColor(index),
    label: resolveModelLabel(intl, model.modelId),
  }));
  const modelKeyById = new Map(modelKeys.map((model) => [model.modelId ?? "__unknown__", model.key]));
  const chartConfig = modelKeys.reduce<ChartConfig>((config, model) => {
    config[model.key] = {
      label: model.label,
      color: model.color,
    };
    return config;
  }, {});
  const chartData = buildDailyModelChartData({
    snapshot,
    locale,
    modelKeys,
    modelKeyById,
  });
  let maxModelTokens = 0;
  let maxTotalTokens = 0;
  for (const row of chartData) {
    maxTotalTokens = Math.max(maxTotalTokens, row.total);
    // 分模型是独立折线而非堆叠图，Y 轴上限只跟随单模型单点峰值；
    // 用每日总量会把多模型之和（含长尾模型）当作上限，可见曲线被压在底部。
    for (const model of modelKeys) {
      maxModelTokens = Math.max(maxModelTokens, Number(row[model.key] ?? 0));
    }
  }

  return {
    models,
    modelKeys,
    chartConfig,
    chartData,
    maxModelTokens,
    maxTotalTokens,
  };
}
