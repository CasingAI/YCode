import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOpenRouterAmount,
  formatOpenRouterCurrencyAmount,
} from "@/settings/model-provider-section/openrouterBalanceDisplay.js";
import {
  formatAmount,
  formatCurrencyAmount,
  formatGoWindowAmountLine,
  formatUsdCurrencyAmount,
} from "@/settings/model-provider-section/openCodeCurrencyDisplay.js";
import { toOpenCodeZenBalanceLines } from "@/settings/model-provider-section/openCodeZenBalanceDisplay.js";

test("formatOpenRouterAmount 保留两位上限并去掉尾随 0", () => {
  assert.equal(formatOpenRouterAmount(74.75), "74.75");
  assert.equal(formatOpenRouterAmount(100), "100");
  assert.equal(formatOpenRouterAmount(-2.5), "-2.5");
  assert.equal(formatOpenRouterAmount(null), "");
  assert.equal(formatOpenRouterAmount(Number.NaN), "");
});

test("formatOpenRouterCurrencyAmount USD 带符号", () => {
  assert.equal(formatOpenRouterCurrencyAmount(74.75, "en-US"), "$74.75");
  assert.equal(formatOpenRouterCurrencyAmount(null, "en-US"), "");
});

test("formatOpenCodeZenAmount 与 USD 金额同口径", () => {
  assert.equal(formatAmount(12.5), "12.5");
  assert.equal(formatAmount(null), "");
  assert.equal(formatCurrencyAmount(12.5, "USD", "en-US"), "$12.50");
  assert.equal(formatCurrencyAmount(null, "USD", "en-US"), "");
});

test("Go 窗口 detail 与 Zen 余额同口径：美元金额", () => {
  assert.equal(formatUsdCurrencyAmount(7.83, "en-US"), "$7.83");
  assert.equal(formatUsdCurrencyAmount(60, "en-US"), "$60.00");
  // 金额行与标题「剩余额度」、剩余百分比同向：剩余 / 总额（52.17 = 60 - 7.83）。
  assert.equal(formatGoWindowAmountLine(7.83, 60, "en-US"), "$52.17 / $60.00");
});

test("Go 窗口金额行：剩余 / 总额（zh-CN 下 USD 渲染为 US$ 前缀）", () => {
  // 用户截图同组数字：已用 0.68 / 总额 12、4.23 / 30、51.08 / 60。
  assert.equal(formatGoWindowAmountLine(0.68, 12, "zh-CN"), "US$11.32 / US$12.00");
  assert.equal(formatGoWindowAmountLine(4.23, 30, "zh-CN"), "US$25.77 / US$30.00");
  assert.equal(formatGoWindowAmountLine(51.08, 60, "zh-CN"), "US$8.92 / US$60.00");
  // 未用满与刚好用满。
  assert.equal(formatGoWindowAmountLine(0, 12, "zh-CN"), "US$12.00 / US$12.00");
  assert.equal(formatGoWindowAmountLine(12, 12, "zh-CN"), "US$0.00 / US$12.00");
});

test("Go 窗口金额行：超支时剩余钳 0，不出现负金额", () => {
  assert.equal(formatGoWindowAmountLine(15, 12, "zh-CN"), "US$0.00 / US$12.00");
  assert.ok(!formatGoWindowAmountLine(15, 12, "zh-CN").includes("-"));
});

test("Go 窗口金额行：usage 或 limit 缺失时返回空串（调用方不渲染该行）", () => {
  assert.equal(formatGoWindowAmountLine(null, 12, "zh-CN"), "");
  assert.equal(formatGoWindowAmountLine(0.68, null, "zh-CN"), "");
  assert.equal(formatGoWindowAmountLine(null, null, "zh-CN"), "");
});

test("toOpenCodeZenBalanceLines 缺币种丢弃，缺金额保留行", () => {
  const lines = toOpenCodeZenBalanceLines([
    { currency: "", amount: 1 },
    { currency: "USD", amount: null },
    { currency: "USD", amount: 12.5 },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.amount, null);
  assert.equal(lines[1]?.amount, 12.5);
});
