import assert from "node:assert/strict";
import test from "node:test";
import type { CommandCodeQuotaWindow } from "@zcode/shared";
import {
  formatCommandCodeMoney,
  formatCommandCodeWindowDetail,
  sumCommandCodeCredits,
  toCommandCodeQuotaLines,
} from "@/settings/model-provider-section/commandCodeQuotaDisplay.js";

function windowEntry(overrides: Partial<CommandCodeQuotaWindow> = {}): CommandCodeQuotaWindow {
  return {
    key: "five-hour",
    used: 6.4,
    cap: 20,
    usagePercent: 32,
    exceeded: false,
    resetAt: null,
    ...overrides,
  };
}

test("toCommandCodeQuotaLines 原样透传窗口字段", () => {
  const lines = toCommandCodeQuotaLines([
    windowEntry(),
    windowEntry({ key: "weekly", used: 18.5, cap: 50, usagePercent: 37, exceeded: true }),
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.used, 6.4);
  assert.equal(lines[0]?.usagePercent, 32);
  assert.equal(lines[1]?.exceeded, true);
});

test("金额展示固定两位小数美元", () => {
  assert.equal(formatCommandCodeMoney(6.4, "en-US"), "$6.40");
  assert.equal(formatCommandCodeMoney(0, "en-US"), "$0.00");
  assert.equal(formatCommandCodeWindowDetail(windowEntry(), "en-US"), "$6.40 / $20.00");
});

test("余额合计只加已上报项；三项全缺或整体未上报返回 null", () => {
  const total = sumCommandCodeCredits({ monthly: 71.2, purchased: 0, free: 5 });
  assert.ok(Math.abs((total ?? 0) - 76.2) < 1e-9);
  assert.equal(sumCommandCodeCredits({ monthly: 10, purchased: null, free: null }), 10);
  assert.equal(sumCommandCodeCredits({ monthly: null, purchased: null, free: null }), null);
  assert.equal(sumCommandCodeCredits(null), null);
});

test("exceeded 窗口保留原字段，由展示端决定不渲染进度条", () => {
  const lines = toCommandCodeQuotaLines([
    windowEntry({ used: 20, cap: 20, usagePercent: 100, exceeded: true }),
  ]);
  assert.equal(lines[0]?.exceeded, true);
  assert.equal(lines[0]?.usagePercent, 100);
});
