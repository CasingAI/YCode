import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCliProxyQuotaWindow,
  formatCliProxyObservedAgo,
  parseCliProxyQuotaSignals,
} from "../src/cliproxy-account.js";

// 额度窗口归类与时间友好化（docs/specs/plugin-cli-proxy-binary.md）：
// 不硬编码 primary=5h，按 window-minutes 归类；缺字段的窗口丢弃。

test("窗口归类：300≈5小时、10080≈7天，允许小抖动", () => {
  assert.equal(classifyCliProxyQuotaWindow(300), "five-hour");
  assert.equal(classifyCliProxyQuotaWindow(299), "five-hour");
  assert.equal(classifyCliProxyQuotaWindow(10080), "weekly");
  assert.equal(classifyCliProxyQuotaWindow(10079), "weekly");
  assert.equal(classifyCliProxyQuotaWindow(60), "other");
  assert.equal(classifyCliProxyQuotaWindow(null), "other");
});

test("signals 解析：双槽位独立，需三字段齐全", () => {
  const observedAt = "2026-10-13T09:00:00.000Z";
  const { windows, planType } = parseCliProxyQuotaSignals(
    {
      "primary-used-percent": 12.5,
      "primary-window-minutes": 300,
      "primary-reset-after-seconds": 3600,
      "secondary-used-percent": 80,
      "secondary-window-minutes": 10080,
      "secondary-reset-after-seconds": 86400,
      "plan-type": "pro",
    },
    observedAt,
  );
  assert.equal(windows.length, 2);
  assert.equal(windows[0]?.key, "five-hour");
  assert.equal(windows[0]?.usagePercent, 12.5);
  assert.equal(windows[1]?.key, "weekly");
  assert.equal(planType, "pro");
});

test("signals 解析：缺 reset 字段的窗口被丢弃", () => {
  const { windows } = parseCliProxyQuotaSignals(
    { "primary-used-percent": 50, "primary-window-minutes": 300 },
    "2026-10-13T09:00:00.000Z",
  );
  assert.equal(windows.length, 0);
});

test("signals 解析：空对象/缺席返回空", () => {
  assert.deepEqual(parseCliProxyQuotaSignals({}, null).windows, []);
  assert.deepEqual(parseCliProxyQuotaSignals(null, null).windows, []);
  assert.deepEqual(parseCliProxyQuotaSignals(undefined, null).windows, []);
});

test("友好化时间：1分钟内/分钟前/小时前/天前", () => {
  const now = Date.parse("2026-10-13T10:00:00.000Z");
  assert.equal(
    formatCliProxyObservedAgo("2026-10-13T09:59:30.000Z", now),
    "1 分钟内",
  );
  assert.equal(formatCliProxyObservedAgo("2026-10-13T09:55:00.000Z", now), "5 分钟前");
  assert.equal(formatCliProxyObservedAgo("2026-10-13T08:00:00.000Z", now), "2 小时前");
  assert.equal(formatCliProxyObservedAgo("2026-10-10T10:00:00.000Z", now), "3 天前");
  assert.equal(formatCliProxyObservedAgo(null, now), null);
  assert.equal(formatCliProxyObservedAgo("not-a-date", now), null);
});
