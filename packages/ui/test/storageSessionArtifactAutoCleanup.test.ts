import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sectionSource = readFileSync(
  new URL("../src/settings/usage-stats/storage/StorageSection.tsx", import.meta.url),
  "utf8",
);
const zhCnSource = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUsSource = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

test("存储页提供会话产物自动清理开关并经 useSettings 更新", () => {
  assert.ok(sectionSource.includes("useSettings()"));
  assert.ok(sectionSource.includes("sessionArtifactAutoCleanupEnabled"));
  assert.ok(sectionSource.includes("update({ sessionArtifactAutoCleanupEnabled"));
  assert.ok(sectionSource.includes('"settings.storage.autoCleanup"'));
  assert.ok(sectionSource.includes('"settings.storage.autoCleanupDescription"'));
});

test("自动清理开关不进入 model runtime preferences 同步", () => {
  assert.ok(!sectionSource.includes("syncAppRuntimePreferences"));
});

test("自动清理开关具备中英文文案", () => {
  for (const source of [zhCnSource, enUsSource]) {
    assert.ok(source.includes('"settings.storage.autoCleanup"'));
    assert.ok(source.includes('"settings.storage.autoCleanupDescription"'));
  }
});
