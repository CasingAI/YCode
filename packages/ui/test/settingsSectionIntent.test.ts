import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeInitialSettingsSection,
  isSettingsSectionId,
  setPendingSettingsSectionIntent,
  SETTINGS_SECTION_IDS,
} from "../src/lib/settingsNavigation.js";

// 设置分区意图：分区 id 的类型、校验和路由必须来自同一份清单，
// 否则新增分区漏登记会让「跳转到该分区」的意图被静默丢弃。

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
) {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const localStorage = createMemoryStorage();
  const sessionStorage = createMemoryStorage();
  (globalThis as { window?: unknown }).window = {
    localStorage,
    sessionStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  try {
    run({ localStorage, sessionStorage });
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
}

test("每个登记的分区 id 都能通过意图校验", () => {
  for (const section of SETTINGS_SECTION_IDS) {
    assert.equal(isSettingsSectionId(section), true, `${section} 应被识别为分区 id`);
  }
  assert.equal(isSettingsSectionId("not-a-section"), false);
});

test("storage 分区意图不会被丢弃，会话横幅可直接跳到存储管理", () => {
  withBrowserStores(({ sessionStorage }) => {
    setPendingSettingsSectionIntent("storage");
    assert.equal(sessionStorage.getItem("zcode-settings-section-intent"), "storage");
    assert.equal(consumeInitialSettingsSection("general"), "storage");
  });
});

test("filesEditor 分区意图同样可以直达", () => {
  withBrowserStores(() => {
    setPendingSettingsSectionIntent("filesEditor");
    assert.equal(consumeInitialSettingsSection("general"), "filesEditor");
  });
});
