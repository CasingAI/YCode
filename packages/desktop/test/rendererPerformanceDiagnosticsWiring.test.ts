import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Desktop renderer bootstrap 的纯源码接线检查：确认旧临时诊断块已被单例启动替换，
// 且没有在入口重新安装第二套 longtask / LoAF observer。

const mainSource = readFileSync(new URL("../src/renderer/src/main.tsx", import.meta.url), "utf8");

test("非 update-status 窗口启动 renderer 性能诊断", () => {
  assert.match(
    mainSource,
    /if \(windowKind !== "update-status"\) \{\s*startRendererPerformanceDiagnostics\(\);/,
    "bootstrap 必须为普通窗口启动本地诊断单例",
  );
});

test("旧 provider-settings-timing 诊断块已移除", () => {
  assert.doesNotMatch(mainSource, /\[provider-settings-timing\]/);
  assert.doesNotMatch(mainSource, /new PerformanceObserver/);
  assert.doesNotMatch(mainSource, /new Worker\(/);
  assert.doesNotMatch(mainSource, /heartbeatInterval/);
});
