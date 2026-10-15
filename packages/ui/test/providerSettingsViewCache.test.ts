import assert from "node:assert/strict";
import test from "node:test";
import {
  readCachedProviderSettingsView,
  saveCachedProviderSettingsView,
} from "../src/hooks/providerSettingsViewCache.js";

// 模块按调用时机读取 localStorage，测试里用可变桩替换 globalThis。
let store: Map<string, string> = new Map();
const localStorageStub = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

test("缓存视图可写入并读回", () => {
  store = new Map();
  (globalThis as { localStorage?: unknown }).localStorage = localStorageStub;
  const view = { revision: 7, providers: [{ id: "p1" }] } as never;
  saveCachedProviderSettingsView(view);
  const cached = readCachedProviderSettingsView();
  assert.ok(cached);
  assert.equal(typeof cached.savedAt, "number");
  assert.equal((cached.view as { revision: number }).revision, 7);
});

test("缺失或损坏 JSON 静默回退 null", () => {
  store = new Map();
  (globalThis as { localStorage?: unknown }).localStorage = localStorageStub;
  assert.equal(readCachedProviderSettingsView(), null);
  store.set("zcode.provider-settings-view-cache.v1", "{not json");
  assert.equal(readCachedProviderSettingsView(), null);
  store.set(
    "zcode.provider-settings-view-cache.v1",
    JSON.stringify({ savedAt: "bad", view: null }),
  );
  assert.equal(readCachedProviderSettingsView(), null);
});

test("localStorage 抛异常时读写都不冒错", () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error("quota");
    },
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {},
  };
  assert.equal(readCachedProviderSettingsView(), null);
  assert.doesNotThrow(() => saveCachedProviderSettingsView({ revision: 1 } as never));
});
