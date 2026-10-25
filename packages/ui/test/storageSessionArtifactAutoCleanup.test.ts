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
const zhCnSource = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUsSource = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

test("存储页提供模型调用轨迹记录开关并通过运行时偏好同步", () => {
  assert.ok(sectionSource.includes("modelIoRecordingEnabled"));
  assert.ok(sectionSource.includes("update({ modelIoRecordingEnabled: enabled })"));
  assert.ok(sectionSource.includes('"settings.storage.modelIoRecording"'));
  assert.ok(sectionSource.includes('"settings.storage.modelIoRecordingDescription"'));
});

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

test("存储页模型调用轨迹记录开关具备中英文文案", () => {
  for (const source of [zhCnSource, enUsSource]) {
    assert.ok(source.includes('"settings.storage.modelIoRecording"'));
    assert.ok(source.includes('"settings.storage.modelIoRecordingDescription"'));
  }
});

test("自动清理开关具备中英文文案", () => {
  for (const source of [zhCnSource, enUsSource]) {
    assert.ok(source.includes('"settings.storage.autoCleanup"'));
    assert.ok(source.includes('"settings.storage.autoCleanupDescription"'));
  }
});
