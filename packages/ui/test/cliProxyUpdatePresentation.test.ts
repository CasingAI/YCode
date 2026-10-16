import assert from "node:assert/strict";
import test from "node:test";
import {
  cliProxyDownloadPercent,
  formatCliProxyLastCheckAt,
} from "../src/settings/cliProxyUpdatePresentation.js";

void test("totalBytes 为 null 时返回不确定进度", () => {
  assert.equal(cliProxyDownloadPercent(100, null), null);
});

void test("计算进度百分比并截断到 0-100", () => {
  assert.equal(cliProxyDownloadPercent(50, 100), 50);
  assert.equal(cliProxyDownloadPercent(200, 100), 100);
});

void test("按 locale 格式化时间为非空字符串", () => {
  assert.ok(formatCliProxyLastCheckAt("2026-10-17T00:00:00.000Z", "zh-CN").length > 0);
  assert.ok(formatCliProxyLastCheckAt("2026-10-17T00:00:00.000Z", "en-US").length > 0);
});
