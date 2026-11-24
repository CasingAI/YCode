import assert from "node:assert/strict";
import test from "node:test";
import { browserCommandSchema } from "../src/browser-use/commands.js";
import { browserErrorCodeSchema } from "../src/browser-use/command-metadata.js";
import { browserTabSummarySchema } from "../src/browser-use/result.js";
import { appSettingsPatchSchema } from "../src/validationAppSettings.js";

// 内置浏览器代理标签页协议边界（docs/specs/browser-tab-proxy.md）：
// newTab 仅接受显式 proxy:true，proxy:false 与未知字段一律拒绝；
// 代理标签页错误码与 AppSettings 出口地址字段随协议一起锁定。

test("newTab 接受省略 proxy 与显式 proxy:true", () => {
  assert.equal(browserCommandSchema.safeParse({ method: "newTab" }).success, true);
  assert.equal(browserCommandSchema.safeParse({ method: "newTab", proxy: true }).success, true);
});

test("newTab 拒绝 proxy:false 与未知字段，代理只能显式开启", () => {
  assert.equal(browserCommandSchema.safeParse({ method: "newTab", proxy: false }).success, false);
  assert.equal(
    browserCommandSchema.safeParse({ method: "newTab", partition: "persist:custom" }).success,
    false,
  );
});

test("browserTabSummary 强制携带 usesProxy，代理标签页事实由 desktop 唯一给出", () => {
  const base = { tabId: "tab-1", url: "https://example.com/", title: "Example", viewport: { width: 1280, height: 720 } };
  assert.equal(browserTabSummarySchema.safeParse({ ...base, usesProxy: true }).success, true);
  assert.equal(browserTabSummarySchema.safeParse(base).success, false);
});

test("错误码枚举包含 proxy_not_configured", () => {
  assert.equal(browserErrorCodeSchema.safeParse("proxy_not_configured").success, true);
  assert.equal(browserErrorCodeSchema.safeParse("proxy_disabled").success, false);
});

test("AppSettings patch 接受 embeddedBrowserProxy 字符串并拒绝非字符串", () => {
  assert.equal(
    appSettingsPatchSchema.parse({ embeddedBrowserProxy: "127.0.0.1:7890" }).embeddedBrowserProxy,
    "127.0.0.1:7890",
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ embeddedBrowserProxy: 7890 }).success,
    false,
  );
});
