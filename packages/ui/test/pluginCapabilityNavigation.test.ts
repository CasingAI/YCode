import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";
import {
  consumeInitialSettingsSection,
  consumePendingSettingsPluginTab,
  isSettingsSectionEnabled,
  resolveSettingsSection,
  setPendingSettingsPluginIntent,
} from "../src/lib/settingsNavigation.js";

// 插件能力导航收敛（docs/specs/plugin-capability-navigation.md）：
// 边栏不再注册 mcp 独立分区；mcps 深链落到 plugin 分区 + mcps 页签；
// 历史 mcp 偏好/意图迁移到 plugin，避免老用户停留在不存在的分区。

interface MemoryStorageShape {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function createMemoryStorage(initial: Record<string, string> = {}): MemoryStorageShape {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

function withBrowserStores(
  run: (stores: { localStorage: MemoryStorageShape; sessionStorage: MemoryStorageShape }) => void,
  initial?: { localStorage?: Record<string, string> },
) {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousSessionStorage = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  const localStorage = createMemoryStorage(initial?.localStorage);
  const sessionStorage = createMemoryStorage();
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  (globalThis as { window?: unknown }).window = {
    localStorage,
    sessionStorage,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: { type: string }) => {
      listeners.get(event.type)?.forEach((listener) => listener(event));
      return true;
    },
  };
  try {
    run({ localStorage, sessionStorage });
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
    if (previousSessionStorage === undefined) {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    } else {
      (globalThis as { sessionStorage?: unknown }).sessionStorage = previousSessionStorage;
    }
  }
}

test("边栏不再注册 mcp 独立分区，插件聚合页保留", () => {
  const { settingsSections } = createSettingsPageConfig();
  const ids = settingsSections.map((section) => section.id);
  assert.ok(!ids.includes("mcp"), "边栏不应再出现 mcp 独立分区");
  assert.ok(ids.includes("plugin"), "插件聚合页应保留");
  assert.equal(isSettingsSectionEnabled("mcp"), true);
});

test("mcps 深链收敛为 plugin 分区 + mcps 页签", () => {
  withBrowserStores(({ sessionStorage }) => {
    setPendingSettingsPluginIntent("mcps");
    assert.equal(sessionStorage.getItem("zcode-settings-section-intent"), "plugin");
    assert.equal(sessionStorage.getItem("zcode-settings-plugin-tab-intent"), "mcps");
    assert.equal(consumeInitialSettingsSection("general"), "plugin");
    assert.equal(consumePendingSettingsPluginTab(), "mcps");
  });
});

test("历史 mcp 意图与本地偏好迁移到 plugin 聚合页", () => {
  withBrowserStores(
    ({ localStorage, sessionStorage }) => {
      sessionStorage.setItem("zcode-settings-section-intent", "mcp");
      assert.equal(consumeInitialSettingsSection("general"), "plugin");
      assert.equal(resolveSettingsSection("mcp"), "plugin");
      assert.equal(localStorage.getItem("zcode-settings-last-section"), "plugin");
      assert.equal(sessionStorage.getItem("zcode-settings-plugin-tab-intent"), "mcps");
    },
    { localStorage: { "zcode-settings-last-section": "mcp" } },
  );
});
