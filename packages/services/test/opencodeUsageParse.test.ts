import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpencodeAuthCookieHeader,
  normalizeOpencodeWorkspaceId,
  parseOpencodeUsageText,
} from "../src/model-provider/opencodeUsageParse.js";

// 样本结构来自 2026-09-21 对 opencode.ai 的实测：
// HTML 内嵌 store state（SSR flight payload）与 _server server-fn 端点（纯 JS）两种形态。
const FIXTURE_PCT_FIRST = [
  '<script>rollingUsage:$R[34]={status:"ok",usagePercent:5.8,resetInSec:10194,usage:69820486,limit:1200000000}',
  'weeklyUsage:$R[35]={status:"ok",usagePercent:2.3,resetInSec:586053,usage:69820486,limit:3000000000}',
  'monthlyUsage:$R[36]={status:"ok",usagePercent:1.2,resetInSec:2525507,usage:72482043,limit:6000000000}',
].join("");

const FIXTURE_RESET_FIRST = [
  '<script>rollingUsage:$R[12]={status:"rate-limited",resetInSec:300,usagePercent:100}',
  'weeklyUsage:$R[13]={status:"ok",resetInSec:100,usagePercent:42}',
].join("");

// _server 端点 200 响应原文（`;0x...;` 长度头 + server-fn 注册 JS，pretty-print 带空格）。
const SERVER_FN_SAMPLE = `;0x000001bf;
((self.$R = self.$R || {})["server-fn:1"] = [],
($R => $R[0] = {
    mine: !0,
    useBalance: !1,
    allowTraining: !1,
    region: $R[1] = ["us", "eu", "sg", "cn"],
    rollingUsage: $R[2] = {
        status: "ok",
        resetInSec: 10785,
        usagePercent: 5.8,
        usage: 69820486,
        limit: 1200000000
    },
    weeklyUsage: $R[3] = {
        status: "ok",
        resetInSec: 586644,
        usagePercent: 2.3,
        usage: 69820486,
        limit: 3000000000
    },
    monthlyUsage: $R[4] = {
        status: "ok",
        resetInSec: 2526098,
        usagePercent: 1.2,
        usage: 72482043,
        limit: 6000000000
    }
})($R["server-fn:1"]))`;

const NOW_MS = Date.parse("2026-09-21T00:00:00.000Z");

test("解析三窗口用量（usagePercent 在前，含绝对值）", () => {
  const windows = parseOpencodeUsageText(FIXTURE_PCT_FIRST, NOW_MS);
  assert.ok(windows);
  assert.equal(windows.length, 3);
  const [rolling, weekly, monthly] = windows;
  assert.deepEqual(
    { key: rolling.key, percent: rolling.usagePercent, usage: rolling.usage, limit: rolling.limit },
    { key: "rolling", percent: 5.8, usage: 69820486, limit: 1_200_000_000 },
  );
  assert.equal(weekly.usagePercent, 2.3);
  assert.equal(monthly.usagePercent, 1.2);
  assert.equal(rolling.resetAt, new Date(NOW_MS + 10_194_000).toISOString());
});

test("解析 _server 端点的 server-fn JS（pretty-print 带空格，三窗口齐整）", () => {
  const windows = parseOpencodeUsageText(SERVER_FN_SAMPLE, NOW_MS);
  assert.ok(windows);
  assert.equal(windows.length, 3);
  const [rolling, weekly, monthly] = windows;
  assert.equal(rolling.usagePercent, 5.8);
  assert.equal(rolling.usage, 69820486);
  assert.equal(rolling.limit, 1_200_000_000);
  assert.equal(weekly.usagePercent, 2.3);
  assert.equal(monthly.usagePercent, 1.2);
  assert.equal(monthly.limit, 6_000_000_000);
  assert.equal(monthly.resetAt, new Date(NOW_MS + 2_526_098_000).toISOString());
});

test("解析兼容 resetInSec 在前与字段缺失", () => {
  const windows = parseOpencodeUsageText(FIXTURE_RESET_FIRST, NOW_MS);
  assert.ok(windows);
  assert.equal(windows.length, 2);
  const [rolling, weekly] = windows;
  assert.equal(rolling.status, "rate-limited");
  assert.equal(rolling.usagePercent, 100);
  assert.equal(rolling.resetAt, new Date(NOW_MS + 300_000).toISOString());
  assert.equal(weekly.usagePercent, 42);
  // usage/limit 缺失时为 null，展示端只显示百分比。
  assert.equal(weekly.usage, null);
  assert.equal(weekly.limit, null);
});

test("窗口缺 usagePercent 时跳过该窗口，不当作 0%", () => {
  const text = [
    '<script>rollingUsage:$R[1]={status:"ok",resetInSec:10,usagePercent:5}',
    'monthlyUsage:$R[2]={status:"ok",resetInSec:999}',
  ].join("");
  const windows = parseOpencodeUsageText(text, NOW_MS);
  assert.ok(windows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.key, "rolling");
});

test("一个窗口都解析不到时返回 null（页面结构变化）", () => {
  assert.equal(parseOpencodeUsageText("<html>login page</html>", NOW_MS), null);
});

test("Cookie 归一化：裸值 / auth= 前缀 / 整段 Cookie 头", () => {
  assert.equal(buildOpencodeAuthCookieHeader("abc123"), "auth=abc123");
  assert.equal(buildOpencodeAuthCookieHeader("auth=abc123"), "auth=abc123");
  assert.equal(
    buildOpencodeAuthCookieHeader("Cookie: oc_locale=zh; auth=xyz; other=1"),
    "auth=xyz",
  );
  assert.equal(buildOpencodeAuthCookieHeader("   "), "");
});

test("Workspace ID 从裸 ID 或链接中提取", () => {
  assert.equal(
    normalizeOpencodeWorkspaceId("wrk_01KZEM26S3A7ZCB12Y77RH4ZKW"),
    "wrk_01KZEM26S3A7ZCB12Y77RH4ZKW",
  );
  assert.equal(
    normalizeOpencodeWorkspaceId("https://opencode.ai/workspace/wrk_abc123/go"),
    "wrk_abc123",
  );
  assert.equal(normalizeOpencodeWorkspaceId("not-a-workspace"), "");
});
