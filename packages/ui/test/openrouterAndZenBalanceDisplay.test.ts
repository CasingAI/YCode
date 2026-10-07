import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOpenRouterAmount,
  formatOpenRouterCurrencyAmount,
} from "@/settings/model-provider-section/openrouterBalanceDisplay.js";
import {
  formatOpenCodeZenAmount,
  formatOpenCodeZenCurrencyAmount,
  toOpenCodeZenBalanceLines,
} from "@/settings/model-provider-section/openCodeZenBalanceDisplay.js";

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
  assert.equal(formatOpenCodeZenAmount(12.5), "12.5");
  assert.equal(formatOpenCodeZenAmount(null), "");
  assert.equal(formatOpenCodeZenCurrencyAmount(12.5, "USD", "en-US"), "$12.50");
  assert.equal(formatOpenCodeZenCurrencyAmount(null, "USD", "en-US"), "");
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
