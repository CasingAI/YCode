import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompactTokenNumber,
  formatCompactTokenNumberWithMetricUnits,
  formatContextUsageBreakdownLabel,
  formatContextUsageSummary,
  formatModelContextWindowLabel,
} from "../src/lib/tokenNumberFormat.js";

// 容量/规格类数字固定 K/M/B 口径，不随中文 locale 变成「万/亿」。
// 口径边界与验收场景见 docs/specs/token-number-units.md。

test("formatContextUsageSummary：中文 locale 下容量摘要走 K/M 口径", () => {
  assert.equal(
    formatContextUsageSummary({
      locale: "zh-CN",
      percent: 68432 / 200000,
      size: 200000,
      used: 68432,
    }),
    "68.4K/200K (34.2%)",
  );
  assert.equal(
    formatContextUsageSummary({ locale: "zh-CN", percent: 1, size: 200000, used: 200000 }),
    "200K/200K (100%)",
  );
});

test("formatContextUsageBreakdownLabel：来源值与百分比一起展示", () => {
  assert.equal(
    formatContextUsageBreakdownLabel({ locale: "zh-CN", percent: 0.12, tokens: 5_100 }),
    "5.1K (12%)",
  );
  assert.equal(
    formatContextUsageBreakdownLabel({ locale: "zh-CN", percent: 0.12, tokens: 999 }),
    "999 (12%)",
  );
});

test("formatContextUsageBreakdownLabel：千位以下的浮点折算值取整显示，不漏出小数", () => {
  // 浮点 guard：即使上游漏了取整，明细行是 token 计数，也不能渲染成 `305.7`。
  assert.equal(
    formatContextUsageBreakdownLabel({ locale: "zh-CN", percent: 0.013, tokens: 305.68 }),
    "306 (1.3%)",
  );
  assert.equal(
    formatContextUsageBreakdownLabel({ locale: "zh-CN", percent: 0.002, tokens: 50.3 }),
    "50 (0.2%)",
  );
  // 千位及以上是 K/M 缩放值，仍保留一位小数。
  assert.equal(
    formatContextUsageBreakdownLabel({ locale: "zh-CN", percent: 0.583, tokens: 13_500 }),
    "13.5K (58.3%)",
  );
});

test("formatContextUsageBreakdownLabel：历史数据缺少 token 时只显示百分比", () => {
  assert.equal(formatContextUsageBreakdownLabel({ locale: "zh-CN", percent: 0.12 }), "12%");
  assert.equal(
    formatContextUsageBreakdownLabel({ locale: "zh-CN", percent: 0.12, tokens: null }),
    "12%",
  );
});

test("formatContextUsageSummary：摘要里不出现中文万/亿单位", () => {
  const label = formatContextUsageSummary({
    locale: "zh-CN",
    percent: 1_234_567 / 2_000_000,
    size: 2_000_000,
    used: 1_234_567,
  });
  assert.equal(label, "1.2M/2M (61.7%)");
  assert.doesNotMatch(label, /[万亿]/u);
});

test("formatContextUsageSummary：不足千位的用量原样输出，不取整成 K", () => {
  assert.equal(
    formatContextUsageSummary({ locale: "zh-CN", percent: 999 / 200000, size: 200000, used: 999 }),
    "999/200K (0.5%)",
  );
});

test("formatCompactTokenNumberWithMetricUnits：千位以下原样，千位起 K、百万起 M", () => {
  assert.equal(formatCompactTokenNumberWithMetricUnits(999), "999");
  assert.equal(formatCompactTokenNumberWithMetricUnits(68000), "68K");
  assert.equal(formatCompactTokenNumberWithMetricUnits(68432), "68.4K");
  assert.equal(
    formatCompactTokenNumberWithMetricUnits(200000, { maximumFractionDigits: 0 }),
    "200K",
  );
  assert.equal(
    formatCompactTokenNumberWithMetricUnits(1_000_000, { maximumFractionDigits: 0 }),
    "1M",
  );
});

test("formatModelContextWindowLabel：模型 badge 与浮层容量口径一致", () => {
  assert.equal(formatModelContextWindowLabel(200000), "200K");
});

test("反向守卫：消耗量类展示仍跟随 locale（中文保留万/亿）", () => {
  // 用量统计、Start Plan 明细继续用本地化 compact；若这条断言失败，
  // 说明有人把 metric 口径误改成了全局默认，会连带改掉消耗量的中文读法。
  assert.equal(formatCompactTokenNumber("zh-CN", 68432), "6.8万");
  assert.equal(formatCompactTokenNumber("zh-CN", 200000, { maximumFractionDigits: 0 }), "20万");
  assert.equal(formatCompactTokenNumber("en-US", 200000, { maximumFractionDigits: 0 }), "200K");
});
