import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeOpencodeCookieHeader,
  normalizeOpencodeWorkspaceId,
  parseOpencodeUsagePage,
} from "../src/model-provider/opencodeUsageParse.js";

const NOW_MS = Date.parse("2026-09-21T00:00:00.000Z");

/**
 * 样本结构照抄 2026-09-21 从 `/workspace/<id>/go` 抓到的真实页面（数值换成占位值）。
 * 关键形态：窗口是 `$R[n]={…}`，键的位置只放引用 `$R[n]`；页面里另有一个**同名**
 * 字段 `monthlyUsage:null`（账号套餐对象），就是当年让月度窗口时有时无的元凶。
 */
const WINDOW_DEFS = `$R[34]={status:"ok",resetInSec:7384,usagePercent:29.2,usage:350725236,limit:1200000000};$R[35]={status:"ok",resetInSec:560405,usagePercent:14,usage:420545722,limit:3000000000};$R[36]={status:"ok",resetInSec:2499859,usagePercent:7.1,usage:423207279,limit:6000000000}`;

const PLAN_WITH_WINDOWS = `$R[32]={mine:!0,useBalance:!1,rollingUsage:$R[34],weeklyUsage:$R[35],monthlyUsage:$R[36]}`;

const ACCOUNT_PLAN_NULL_TWIN = `$R[20]={monthlyUsage:null,timeMonthlyUsageUpdated:null,reloadError:null,subscribed:!1}`;

function page(...scripts: string[]): string {
  return `<!DOCTYPE html><html><head><script>${scripts.join(";")}</script></head><body></body></html>`;
}

test("页面：三个窗口都能读出来，绝对值与百分比都在", () => {
  const result = parseOpencodeUsagePage(page(WINDOW_DEFS, PLAN_WITH_WINDOWS), NOW_MS);
  assert.deepEqual(
    result.windows.map((window) => window.key),
    ["rolling", "weekly", "monthly"],
  );
  const [rolling, weekly, monthly] = result.windows;
  assert.equal(rolling?.usagePercent, 29.2);
  assert.equal(rolling?.usage, 350_725_236);
  assert.equal(rolling?.limit, 1_200_000_000);
  assert.equal(rolling?.status, "ok");
  assert.equal(rolling?.resetInSec, 7384);
  assert.equal(rolling?.resetAt, new Date(NOW_MS + 7384 * 1000).toISOString());
  assert.equal(weekly?.usagePercent, 14);
  assert.equal(monthly?.usagePercent, 7.1);
  assert.equal(monthly?.limit, 6_000_000_000);
});

test("回归：同名干扰项（monthlyUsage:null）排在前面时，月度窗口不再被丢掉", () => {
  // 这正是「月额度时而显示、时而不显示」的成因：旧实现取 `monthlyUsage:` 的**首次**
  // 出现位置，撞上账号套餐里的 `monthlyUsage:null` 就静默丢弃该窗口。
  const result = parseOpencodeUsagePage(
    page(ACCOUNT_PLAN_NULL_TWIN, WINDOW_DEFS, PLAN_WITH_WINDOWS),
    NOW_MS,
  );
  assert.deepEqual(
    result.windows.map((window) => window.key),
    ["rolling", "weekly", "monthly"],
  );
  assert.equal(result.windows[2]?.usagePercent, 7.1);
  // 播放干扰项是为了让下次排查一眼看出「顺序变了没有」。
  assert.ok(result.ignored.some((entry) => entry === "monthlyUsage:null"));
});

test("窗口对象已内联过时，键位置只剩引用也能展开", () => {
  const result = parseOpencodeUsagePage(
    page(
      // 定义出现在引用之前很远的位置，且键后面紧跟的只是 `$R[n]`（没有 `{`）。
      `$R[7]={status:"ok",resetInSec:100,usagePercent:42,usage:42,limit:100}`,
      `$R[9]={mine:!0,rollingUsage:$R[7]}`,
    ),
    NOW_MS,
  );
  assert.equal(result.sources.rolling, "reference");
  assert.equal(result.windows[0]?.usagePercent, 42);
  // 页面里没有 weekly/monthly：如实报告 absent，不能凭 rolling 猜另外两个。
  assert.equal(result.sources.weekly, "absent");
  assert.equal(result.sources.monthly, "absent");
});

test("字面量直接内联在键后面时按 inline 记录", () => {
  const result = parseOpencodeUsagePage(
    page(`$R[3]={rollingUsage:{status:"ok",resetInSec:60,usagePercent:5,usage:5,limit:100}}`),
    NOW_MS,
  );
  assert.equal(result.sources.rolling, "inline");
  assert.equal(result.windows[0]?.usagePercent, 5);
});

test("字符串里的花括号与转义引号不会破坏解析", () => {
  const result = parseOpencodeUsagePage(
    page(
      `$R[1]={message:"a {b} \\"c\\" }",nested:{deep:{rollingUsage:$R[2]={status:"ok",resetInSec:60,usagePercent:12,limit:100,usage:12}},label:"{not a key"}`,
    ),
    NOW_MS,
  );
  assert.equal(result.windows[0]?.usagePercent, 12);
});

test("前缀相同的字段名（timeMonthlyUsageUpdated）不会被误当作窗口键", () => {
  const result = parseOpencodeUsagePage(
    page(
      `$R[5]={timeMonthlyUsageUpdated:123,monthlyUsage:$R[6]={status:"ok",resetInSec:60,usagePercent:8,limit:100,usage:8}}`,
    ),
    NOW_MS,
  );
  assert.equal(result.sources.monthly, "reference");
  assert.equal(result.windows[0]?.usagePercent, 8);
});

test("窗口缺 usagePercent 时按 absent 处理，不当作 0%", () => {
  const result = parseOpencodeUsagePage(
    page(`$R[8]={rollingUsage:{status:"ok",resetInSec:60}}`),
    NOW_MS,
  );
  assert.deepEqual(result.windows, []);
  assert.equal(result.sources.rolling, "absent");
});

test("页面没有窗口（未启用套餐/远端改版）时返回空窗口集，不抛错", () => {
  const result = parseOpencodeUsagePage(page(`$R[1]={hello:"world"}`), NOW_MS);
  assert.deepEqual(result.windows, []);
  assert.deepEqual(result.sources, {
    rolling: "absent",
    weekly: "absent",
    monthly: "absent",
  });
});

test("usage/limit 缺失时保留 null（只显示百分比），字符串数字也能读", () => {
  const result = parseOpencodeUsagePage(
    page(`$R[4]={rollingUsage:{status:"ok",resetInSec:"120",usagePercent:"33.5"}}`),
    NOW_MS,
  );
  assert.equal(result.windows[0]?.usagePercent, 33.5);
  assert.equal(result.windows[0]?.usage, null);
  assert.equal(result.windows[0]?.limit, null);
  assert.equal(result.windows[0]?.resetInSec, 120);
});

test("引号形式的键也能读到", () => {
  const result = parseOpencodeUsagePage(
    page(
      `$R[11]={"rollingUsage":$R[12]={status:"ok",resetInSec:60,usagePercent:3,limit:100,usage:3}}`,
    ),
    NOW_MS,
  );
  assert.equal(result.windows[0]?.usagePercent, 3);
});

test("凭据归一化：原始 token 包装成 auth=，整段 Cookie 原样透传", () => {
  assert.equal(normalizeOpencodeCookieHeader("abc123"), "auth=abc123");
  assert.equal(normalizeOpencodeCookieHeader("auth=abc123"), "auth=abc123");
  // 用户从 DevTools 复制到的主要形态：Iron Session 密封串（含 * - _ 等字符）。
  const rawToken = "Fe26.2**b1f0a*Xk9-dG_2Q**7c1e4*Zm5nR8tYvW3a";
  assert.equal(normalizeOpencodeCookieHeader(rawToken), `auth=${rawToken}`);
  assert.equal(normalizeOpencodeCookieHeader(`auth=${rawToken}`), `auth=${rawToken}`);
  // 整段 Cookie 头：剥前缀后**原样透传全部 cookie**——不按名字白名单过滤，
  // 否则名字没猜中的会话 cookie 会被静默丢掉、表现为一律被拒。
  assert.equal(
    normalizeOpencodeCookieHeader("Cookie: oc_locale=zh; auth=xyz; oc_session=sess; other=1"),
    "oc_locale=zh; auth=xyz; oc_session=sess; other=1",
  );
  // 无 name=value 且不像 token 时不当作 auth。
  assert.equal(normalizeOpencodeCookieHeader("   "), "");
  assert.equal(normalizeOpencodeCookieHeader("Cookie: ;; ;"), "");
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
