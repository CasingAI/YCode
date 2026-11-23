import assert from "node:assert/strict";
import test from "node:test";
import type { UsageQuotaLimit } from "@zcode/shared";
import { resolveZhipuQuotaLimitLabelId } from "@/chat-input-toolbar/ZhipuContextQuota.js";

function limit(overrides: Partial<UsageQuotaLimit>): Pick<UsageQuotaLimit, "type" | "unit" | "number"> {
  return { usageDetails: [], ...overrides };
}

test("CREDIT_LIMIT 周窗口映射到「每周」而不是原始 type", () => {
  assert.equal(
    resolveZhipuQuotaLimitLabelId(limit({ type: "CREDIT_LIMIT", unit: 6 })),
    "sidebar.usage.plan.weekly",
  );
});

test("TOKENS_LIMIT / CREDIT_LIMIT 五小时窗口映射到「5 小时」", () => {
  for (const type of ["TOKENS_LIMIT", "CREDIT_LIMIT"]) {
    assert.equal(
      resolveZhipuQuotaLimitLabelId(limit({ type, unit: 3, number: 5 })),
      "sidebar.usage.plan.fiveHour",
    );
  }
});

test("非 Token 类配额或未知窗口回退", () => {
  assert.equal(resolveZhipuQuotaLimitLabelId(limit({ type: "TIME_LIMIT", unit: 3, number: 5 })), null);
  assert.equal(
    resolveZhipuQuotaLimitLabelId(limit({ type: "CREDIT_LIMIT", unit: 3, number: 1 })),
    null,
  );
  assert.equal(resolveZhipuQuotaLimitLabelId(limit({ type: undefined })), null);
});
