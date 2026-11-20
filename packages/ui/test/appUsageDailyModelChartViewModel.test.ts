import assert from "node:assert/strict";
import test from "node:test";
import type { AppUsageSnapshot } from "@zcode/shared";
import { buildAppUsageDailyModelChartViewModel } from "../src/settings/usage-stats/appUsageDailyModelChartViewModel.js";

const intl = { formatMessage: (descriptor: { id: string }) => descriptor.id };

type SnapshotInput = {
  models: Array<{ modelId: string | null; totalTokens: number }>;
  dailyModelUsage: Array<{
    date: string;
    models: Array<{ modelId: string | null; totalTokens: number }>;
  }>;
};

function buildSnapshot(input: SnapshotInput): AppUsageSnapshot {
  return input as unknown as AppUsageSnapshot;
}

test("分模型模式绘制全部有量模型，不再截断前 6 名", () => {
  const modelIds = [
    "deepseek/deepseek-v4.1-flash",
    "GLM-5.3-Flash",
    "deepseek-v4.1-flash",
    "deepseek-flash",
    "minimax-m3.1-flash-free",
    "MiniMax-M3.1-Flash",
    "hy4-flash-free",
    "glm-5.3",
  ];
  const snapshot = buildSnapshot({
    models: modelIds.map((modelId, index) => ({
      modelId,
      totalTokens: (modelIds.length - index) * 100,
    })),
    dailyModelUsage: [
      {
        date: "2026-11-20",
        models: modelIds.map((modelId) => ({ modelId, totalTokens: 50 })),
      },
    ],
  });

  const view = buildAppUsageDailyModelChartViewModel({ intl, locale: "zh-CN", snapshot });

  assert.equal(view.models.length, 8);
  assert.equal(view.modelKeys.length, 8);
  assert.equal(Object.keys(view.chartConfig).length, 8);
  // 排名第 8 的 glm-5.3 当天有量，必须有自己的折线数据，否则 tooltip 标题
  // （全天合计）会大于可见行合计，回到本次修复前的缺陷。
  const glmKey = view.modelKeys.find((key) => key.modelId === "glm-5.3");
  assert.ok(glmKey, "glm-5.3 应生成折线 key");
  const dayRow = view.chartData[0];
  assert.equal(dayRow[glmKey.key], 50);
  assert.equal(dayRow.total, 8 * 50);
});

test("0 用量模型不画线、不进图例", () => {
  const snapshot = buildSnapshot({
    models: [
      { modelId: "glm-5.3", totalTokens: 300 },
      { modelId: "empty-model", totalTokens: 0 },
    ],
    dailyModelUsage: [
      { date: "2026-11-20", models: [{ modelId: "glm-5.3", totalTokens: 300 }] },
    ],
  });

  const view = buildAppUsageDailyModelChartViewModel({ intl, locale: "zh-CN", snapshot });

  assert.deepEqual(
    view.modelKeys.map((key) => key.modelId),
    ["glm-5.3"],
  );
});

test("tooltip 标题合计等于当天全部模型之和，每个有量模型都有行值", () => {
  const dayModels = [
    { modelId: "codex-6c3b1ab0/gpt-6.1-sol", totalTokens: 1_660_000_011 },
    { modelId: "deepseek-v4.1-flash", totalTokens: 123_120_014 },
    { modelId: "glm-5.3", totalTokens: 93_742_178 },
    { modelId: "deepseek/deepseek-v4.1-flash", totalTokens: 82_833_798 },
  ];
  const snapshot = buildSnapshot({
    models: [...dayModels, { modelId: "idle-model", totalTokens: 10 }],
    dailyModelUsage: [{ date: "2026-11-20", models: dayModels }],
  });

  const view = buildAppUsageDailyModelChartViewModel({ intl, locale: "zh-CN", snapshot });
  const dayRow = view.chartData[0];

  assert.equal(dayRow.total, dayModels.reduce((sum, model) => sum + model.totalTokens, 0));
  for (const model of dayModels) {
    const key = view.modelKeys.find((entry) => entry.modelId === model.modelId);
    assert.ok(key, `${model.modelId} 应有折线 key`);
    assert.equal(dayRow[key.key], model.totalTokens);
  }
});

test("分模型峰值取单模型单点最大值，总量峰值取全天合计最大值", () => {
  const snapshot = buildSnapshot({
    models: [
      { modelId: "a", totalTokens: 700 },
      { modelId: "b", totalTokens: 300 },
    ],
    dailyModelUsage: [
      { date: "2026-11-19", models: [{ modelId: "a", totalTokens: 400 }] },
      {
        date: "2026-11-20",
        models: [
          { modelId: "a", totalTokens: 300 },
          { modelId: "b", totalTokens: 300 },
        ],
      },
    ],
  });

  const view = buildAppUsageDailyModelChartViewModel({ intl, locale: "zh-CN", snapshot });

  assert.equal(view.maxModelTokens, 400);
  assert.equal(view.maxTotalTokens, 600);
});

test("颜色超过 6 个模型后按色板循环", () => {
  const modelIds = Array.from({ length: 8 }, (_, index) => `model-${index}`);
  const snapshot = buildSnapshot({
    models: modelIds.map((modelId) => ({ modelId, totalTokens: 100 })),
    dailyModelUsage: [
      { date: "2026-11-20", models: modelIds.map((modelId) => ({ modelId, totalTokens: 100 })) },
    ],
  });

  const view = buildAppUsageDailyModelChartViewModel({ intl, locale: "zh-CN", snapshot });

  assert.equal(view.modelKeys[6].color, view.modelKeys[0].color);
  assert.equal(view.modelKeys[7].color, view.modelKeys[1].color);
});

test("日期行按日期升序排列", () => {
  const snapshot = buildSnapshot({
    models: [{ modelId: "a", totalTokens: 10 }],
    dailyModelUsage: [
      { date: "2026-11-20", models: [{ modelId: "a", totalTokens: 4 }] },
      { date: "2026-11-18", models: [{ modelId: "a", totalTokens: 3 }] },
      { date: "2026-11-19", models: [{ modelId: "a", totalTokens: 3 }] },
    ],
  });

  const view = buildAppUsageDailyModelChartViewModel({ intl, locale: "zh-CN", snapshot });

  assert.deepEqual(
    view.chartData.map((row) => row.tooltipLabel),
    ["11月18日", "11月19日", "11月20日"],
  );
});
