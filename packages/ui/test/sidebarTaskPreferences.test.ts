import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserStorageLike } from "../src/lib/browserEnvironment.js";
import {
  persistSidebarTaskPreferences,
  readSidebarTaskPreferences,
  type SidebarTaskOrganizeBy,
  type SidebarTaskSortBy,
} from "../src/lib/sidebarTaskPreferences.js";

// 统一注入内存 storage，避免依赖 Node 全局 localStorage 或污染其他测试文件。
// 本文件只验证偏好存储层，不覆盖 WorkspaceSidebar 菜单渲染。
const STORAGE_KEY = "zcode-sidebar-task-preferences";

class MemoryStorage implements BrowserStorageLike {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  seed(key: string, value: string): void {
    this.data.set(key, value);
  }

  raw(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  keys(): string[] {
    return [...this.data.keys()];
  }
}

const ORGANIZE_BY_VALUES: SidebarTaskOrganizeBy[] = ["grouped", "project", "chronological"];
const SORT_BY_VALUES: SidebarTaskSortBy[] = ["updated", "created"];

const ORGANIZE_BY_SORT_BY_COMBINATIONS = ORGANIZE_BY_VALUES.flatMap((organizeBy) =>
  SORT_BY_VALUES.map((sortBy) => ({ organizeBy, sortBy })),
);

const DEFAULT_PREFERENCES = { organizeBy: "project", sortBy: "updated" } as const;

test("旧数据：分组/项目/时间线 × 更新时间/创建时间都能直接读回", () => {
  for (const { organizeBy, sortBy } of ORGANIZE_BY_SORT_BY_COMBINATIONS) {
    const storage = new MemoryStorage();
    storage.seed(STORAGE_KEY, JSON.stringify({ organizeBy, sortBy }));

    assert.deepEqual(
      readSidebarTaskPreferences(storage),
      { organizeBy, sortBy },
      `${organizeBy}/${sortBy} 的旧偏好应原样生效`,
    );
  }
});

test("持久化往返：三视图两排序写回后读取保持一致", () => {
  for (const { organizeBy, sortBy } of ORGANIZE_BY_SORT_BY_COMBINATIONS) {
    const storage = new MemoryStorage();

    persistSidebarTaskPreferences({ organizeBy, sortBy }, storage);

    assert.deepEqual(readSidebarTaskPreferences(storage), { organizeBy, sortBy });
  }
});

test("持久化只写标准 key 与 organizeBy/sortBy 两个字段", () => {
  const storage = new MemoryStorage();

  persistSidebarTaskPreferences({ organizeBy: "chronological", sortBy: "created" }, storage);

  assert.deepEqual(storage.keys(), [STORAGE_KEY]);
  assert.deepEqual(JSON.parse(storage.raw(STORAGE_KEY) ?? "null"), {
    organizeBy: "chronological",
    sortBy: "created",
  });
});

test("切换视图只在存储层改写 organizeBy，已选排序不丢失", () => {
  const storage = new MemoryStorage();
  persistSidebarTaskPreferences({ organizeBy: "project", sortBy: "created" }, storage);

  // 唯一写入 effect 会同时落盘两项，这里只验证存储层不会丢掉未改动的字段。
  for (const organizeBy of ORGANIZE_BY_VALUES) {
    const current = readSidebarTaskPreferences(storage);
    persistSidebarTaskPreferences({ organizeBy, sortBy: current.sortBy }, storage);

    assert.deepEqual(
      readSidebarTaskPreferences(storage),
      { organizeBy, sortBy: "created" },
      `切到 ${organizeBy} 后创建时间排序应保留`,
    );
  }
});

test("切换排序只在存储层改写 sortBy，已选视图不丢失", () => {
  const storage = new MemoryStorage();
  persistSidebarTaskPreferences({ organizeBy: "grouped", sortBy: "updated" }, storage);

  for (const sortBy of SORT_BY_VALUES) {
    const current = readSidebarTaskPreferences(storage);
    persistSidebarTaskPreferences({ organizeBy: current.organizeBy, sortBy }, storage);

    assert.deepEqual(
      readSidebarTaskPreferences(storage),
      { organizeBy: "grouped", sortBy },
      `切到 ${sortBy} 后分组视图应保留`,
    );
  }
});

test("storage 缺失或 key 缺失时回退默认 project + updated", () => {
  assert.deepEqual(readSidebarTaskPreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(readSidebarTaskPreferences(new MemoryStorage()), DEFAULT_PREFERENCES);
});

test("非法 JSON 回退默认 project + updated", () => {
  const storage = new MemoryStorage();
  storage.seed(STORAGE_KEY, "{not-json");

  assert.deepEqual(readSidebarTaskPreferences(storage), DEFAULT_PREFERENCES);
});

test("非对象 JSON 回退默认 project + updated", () => {
  for (const rawValue of ["null", "[]", "42", '"chronological"']) {
    const storage = new MemoryStorage();
    storage.seed(STORAGE_KEY, rawValue);

    assert.deepEqual(
      readSidebarTaskPreferences(storage),
      DEFAULT_PREFERENCES,
      `${rawValue} 不是合法偏好对象`,
    );
  }
});

test("未知或缺失字段按字段独立回退，另一字段仍生效", () => {
  const cases = [
    {
      raw: { organizeBy: "archived", sortBy: "created" },
      expected: { organizeBy: "project", sortBy: "created" },
    },
    {
      raw: { organizeBy: "timeline", sortBy: "updated" },
      expected: { organizeBy: "project", sortBy: "updated" },
    },
    {
      raw: { organizeBy: "grouped", sortBy: "recent" },
      expected: { organizeBy: "grouped", sortBy: "updated" },
    },
    {
      raw: { organizeBy: "chronological" },
      expected: { organizeBy: "chronological", sortBy: "updated" },
    },
    { raw: { sortBy: "created" }, expected: { organizeBy: "project", sortBy: "created" } },
    { raw: {}, expected: DEFAULT_PREFERENCES },
    { raw: { organizeBy: null, sortBy: 1 }, expected: DEFAULT_PREFERENCES },
  ] as const;

  for (const { raw, expected } of cases) {
    const storage = new MemoryStorage();
    storage.seed(STORAGE_KEY, JSON.stringify(raw));

    assert.deepEqual(
      readSidebarTaskPreferences(storage),
      expected,
      `${JSON.stringify(raw)} 应按字段回退`,
    );
  }
});

test("getItem 抛错时静默回退默认值", () => {
  const throwingStorage: BrowserStorageLike = {
    getItem: () => {
      throw new Error("storage blocked");
    },
    setItem: () => {},
  };

  assert.deepEqual(readSidebarTaskPreferences(throwingStorage), DEFAULT_PREFERENCES);
});

test("setItem 抛错时不阻断调用方（隐私模式/配额受限）", () => {
  const throwingStorage: BrowserStorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };

  assert.doesNotThrow(() =>
    persistSidebarTaskPreferences({ organizeBy: "grouped", sortBy: "created" }, throwingStorage),
  );
  assert.doesNotThrow(() =>
    persistSidebarTaskPreferences({ organizeBy: "project", sortBy: "updated" }, null),
  );
});
