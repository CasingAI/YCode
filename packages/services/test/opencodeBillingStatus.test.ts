import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapBillingStatusBalance } from "../src/model-provider/opencodeConsoleApi.js";

describe("mapBillingStatusBalance", () => {
  it("顶层 balance 数字直接解析", () => {
    assert.deepEqual(mapBillingStatusBalance({ balance: 12.5 }), [
      { currency: "USD", amount: 12.5 },
    ]);
  });

  it("顶层 credits 字符串转数值，币种取同级 currency", () => {
    assert.deepEqual(mapBillingStatusBalance({ credits: "99.99", currency: "USD" }), [
      { currency: "USD", amount: 99.99 },
    ]);
  });

  it("data 嵌套形态同样解析", () => {
    assert.deepEqual(mapBillingStatusBalance({ data: { balance: "7.5" } }), [
      { currency: "USD", amount: 7.5 },
    ]);
  });

  it('真实响应（2026-10-07 抓包）：balanceMicroCents 微美分字符串，"0" 是合法余额', () => {
    // prepaid/pay-as-you-go 账户没充值过余额：必须展示 $0，不得按 unavailable 处理。
    assert.deepEqual(
      mapBillingStatusBalance({
        billingMode: "prepaid",
        mode: "pay-as-you-go",
        balanceMicroCents: "0",
        creditLimitMicroCents: null,
        availableMicroCents: "0",
        canPurchaseCredits: true,
        canEnableAutoRecharge: true,
      }),
      [{ currency: "USD", amount: 0 }],
    );
  });

  it("balanceMicroCents 非零微美分换算成美元（1e6 微美分 = 1 美元）", () => {
    assert.deepEqual(mapBillingStatusBalance({ balanceMicroCents: "123456789" }), [
      { currency: "USD", amount: 123.456789 },
    ]);
  });

  it("balanceMicroCents 为 null 时回退 availableMicroCents（授信不作首选）", () => {
    assert.deepEqual(
      mapBillingStatusBalance({ balanceMicroCents: null, availableMicroCents: "5000000" }),
      [{ currency: "USD", amount: 5 }],
    );
  });

  it("数字形态的 balanceMicroCents 同样解析", () => {
    assert.deepEqual(mapBillingStatusBalance({ balanceMicroCents: 2500000 }), [
      { currency: "USD", amount: 2.5 },
    ]);
  });

  it("嵌套对象形态 { balance: { amount, currency } }", () => {
    assert.deepEqual(mapBillingStatusBalance({ balance: { amount: "3.25", currency: "USD" } }), [
      { currency: "USD", amount: 3.25 },
    ]);
  });

  it("所有金额都解析不出时返回空数组（调用方按 unavailable 上报，不当 0）", () => {
    assert.deepEqual(mapBillingStatusBalance({}), []);
    assert.deepEqual(mapBillingStatusBalance({ balance: "abc" }), []);
    assert.deepEqual(mapBillingStatusBalance(null as never), []);
    assert.deepEqual(mapBillingStatusBalance("x" as never), []);
  });
});
