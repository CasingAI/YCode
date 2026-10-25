import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sectionSource = readFileSync(
  new URL(
    "../src/settings/usage-stats/storage/StorageOptionsPanel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const sessionPaneSource = readFileSync(
  new URL("../src/v4/SessionPane.tsx", import.meta.url),
  "utf8",
);
const warningSource = readFileSync(
  new URL("../src/v4/SessionStorageWarning.tsx", import.meta.url),
  "utf8",
);
const zhCnSource = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUsSource = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

test("存储页提供会话产物占用提示开关并经 useSettings 更新", () => {
  assert.ok(sectionSource.includes("useSettings()"));
  assert.ok(sectionSource.includes("sessionStorageWarningEnabled"));
  assert.ok(sectionSource.includes("update({ sessionStorageWarningEnabled: enabled })"));
  assert.ok(sectionSource.includes('"settings.storage.sessionStorageWarning"'));
  assert.ok(sectionSource.includes('"settings.storage.sessionStorageWarningDescription"'));
});

test("会话产物占用提示开关具备中英文文案", () => {
  for (const source of [zhCnSource, enUsSource]) {
    assert.ok(source.includes('"settings.storage.sessionStorageWarning"'));
    assert.ok(source.includes('"settings.storage.sessionStorageWarningDescription"'));
  }
});

test("会话横幅按全局开关决定是否扫描与显示", () => {
  assert.ok(warningSource.includes("resolveSessionStorageWarningVisibility"));
  assert.ok(warningSource.includes("if (shouldScan && enabled) runAutomaticScan();"));
  assert.ok(sessionPaneSource.includes("enabled={sessionStorageWarningEnabled}"));
});
