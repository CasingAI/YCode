import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompactTokenNumber,
  formatCompactTokenNumberWithMetricUnits,
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
