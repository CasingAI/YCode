import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const storageSectionSource = readFileSync(
  new URL(
    "../src/settings/usage-stats/storage/StorageSection.tsx",
    import.meta.url,
  ),
  "utf8",
);
const storageOptionsSource = readFileSync(
  new URL(
    "../src/settings/usage-stats/storage/StorageOptionsPanel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const storageUsageSource = readFileSync(
  new URL(
    "../src/settings/usage-stats/storage/StorageUsagePanel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const settingsPageSource = readFileSync(
  new URL("../src/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const pluginStoreSource = readFileSync(
  new URL("../src/settings/PluginStoreListView.tsx", import.meta.url),
  "utf8",
);
const zhCnSource = readFileSync(
  new URL("../src/i18n/locales/zh-CN.ts", import.meta.url),
  "utf8",
);
const enUsSource = readFileSync(
  new URL("../src/i18n/locales/en-US.ts", import.meta.url),
  "utf8",
);

test("存储分区按 activeTab 互斥挂载占用统计与存储选项面板", () => {
  assert.ok(
    storageSectionSource.includes('activeTab === "options"'),
    "分区必须按当前 tab 选择面板",
  );
  assert.ok(storageSectionSource.includes("<StorageOptionsPanel />"));
  assert.ok(
    storageSectionSource.includes(
      "<StorageUsagePanel bridge={bridge} active={active} />",
    ),
  );
  // 占用统计面板只在“占用统计”分支挂载：切到存储选项时不保留扫描面板。
  const optionsBranch = storageSectionSource.split('activeTab === "options"')[1] ?? "";
  assert.ok(
    !optionsBranch.split(") : (")[0]?.includes("StorageUsagePanel"),
    "存储选项分支不得同时挂载占用统计面板",
  );
});

test("占用统计面板的扫描由宿主桥驱动，存储选项面板不触碰扫描", () => {
  assert.ok(storageUsageSource.includes("useStorageUsage({"));
  assert.ok(storageUsageSource.includes("enabled: active"));
  assert.ok(!storageOptionsSource.includes("useStorageUsage"));
  assert.ok(!storageOptionsSource.includes("StorageManagementBridge"));
});

test("设置页持有存储 tab 选择态并在分区标题旁渲染切换器", () => {
  assert.ok(
    settingsPageSource.includes("useState<StorageSectionTab>"),
    "tab 选择态必须由设置页持有",
  );
  assert.ok(settingsPageSource.includes("<SettingsStorageTabs"));
  assert.ok(settingsPageSource.includes("activeTab={storageActiveTab}"));
  assert.ok(!storageSectionSource.includes("useState"));
});

test("存储与使用统计复用同一套 pill 分段控件", () => {
  assert.ok(settingsPageSource.includes("SettingsSegmentPill"));
  assert.ok(pluginStoreSource.includes("SettingsSegmentPill"));
  assert.ok(!pluginStoreSource.includes("export function SegmentPill"));
});

test("存储 tab 文案具备中英文", () => {
  for (const source of [zhCnSource, enUsSource]) {
    assert.ok(source.includes('"settings.storage.tab.usage"'));
    assert.ok(source.includes('"settings.storage.tab.options"'));
  }
});
