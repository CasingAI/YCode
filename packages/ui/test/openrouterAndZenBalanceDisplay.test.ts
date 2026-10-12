import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOpenRouterAmount,
  formatOpenRouterCurrencyAmount,
} from "@/settings/model-provider-section/openrouterBalanceDisplay.js";
import {
  formatAmount,
  formatCurrencyAmount,
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
  assert.equal(
    `${formatUsdCurrencyAmount(7.83, "en-US")} / ${formatUsdCurrencyAmount(60, "en-US")}`,
    "$7.83 / $60.00",
  );
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
