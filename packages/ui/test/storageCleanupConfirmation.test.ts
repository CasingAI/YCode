import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cleanupDialogSource = readFileSync(
  new URL("../src/settings/usage-stats/storage/StorageCleanupDialog.tsx", import.meta.url),
  "utf8",
);
const confirmDialogSource = readFileSync(
  new URL("../src/settings/usage-stats/storage/StorageCleanConfirmDialog.tsx", import.meta.url),
  "utf8",
);
const storageSectionSource = readFileSync(
  new URL(
    "../src/settings/usage-stats/storage/StorageUsagePanel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const usageHookSource = readFileSync(
  new URL("../src/settings/usage-stats/storage/useStorageUsage.ts", import.meta.url),
  "utf8",
);
const zhCnSource = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUsSource = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

test("清理对话框提供四个范围，并将选中范围提交给服务", () => {
  assert.ok(
    cleanupDialogSource.includes('["24hours", "7days", "30days", "all"]'),
    "必须显示四个清理范围",
  );
  assert.ok(cleanupDialogSource.includes("ageRange: range"), "确认时必须提交范围标识");
  assert.ok(cleanupDialogSource.includes('"settings.storage.cleanupAllWarning"'));
});

test("全部删除需要二次确认并显示永久删除警告", () => {
  assert.ok(storageSectionSource.includes('selection.ageRange === "all"'));
  assert.ok(storageSectionSource.includes('permanent={pendingSelection?.ageRange === "all"}'));
  assert.ok(confirmDialogSource.includes('"settings.storage.confirmPermanentWarning"'));
  assert.ok(confirmDialogSource.includes('"settings.storage.confirmPermanentTitle"'));
});

test("删除完成后自动重扫，清理结果不显示逻辑文件大小", () => {
  assert.ok(usageHookSource.includes("await start()"), "清理后必须启动重新扫描");
  assert.ok(storageSectionSource.includes('"settings.storage.cleanPartial"'));
  assert.ok(storageSectionSource.includes("merged.failures"));
  assert.ok(storageSectionSource.includes("onAction: () => setCleanupFailures(merged.failures)"));
  assert.ok(storageSectionSource.includes("merged.freedBytes") === false);
});

test("中英文文案都说明全部删除不可恢复且可能影响运行任务", () => {
  for (const source of [zhCnSource, enUsSource]) {
    assert.ok(source.includes('"settings.storage.confirmPermanentWarning"'));
    assert.ok(source.includes('"settings.storage.cleanupAllWarning"'));
    assert.ok(source.includes('"settings.storage.cleanupRange.24hours"'));
    assert.ok(source.includes('"settings.storage.cleanPartial"'));
  }
});
