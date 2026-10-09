import assert from "node:assert/strict";
import test from "node:test";

// taskNotificationPreferences 直接读写全局 localStorage；Node 下没有，
// 这里挂一个内存实现（用完恢复，避免污染其他测试文件）。
class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const previousLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
test.after(() => {
  (globalThis as { localStorage?: unknown }).localStorage = previousLocalStorage;
});

const {
  getEffectiveSoundCue,
  getEffectiveSoundSelection,
  getSystemSoundMap,
  persistSystemSoundMap,
} = await import("../src/lib/taskNotificationPreferences.js");

function resetStorage(): void {
  (globalThis.localStorage as Storage).clear();
}

function storage(): Storage {
  return globalThis.localStorage as Storage;
}

test("空映射时四行取默认 {minimal, 默认cue}", { concurrency: false }, () => {
  resetStorage();
  assert.deepEqual(getSystemSoundMap(), {});
  assert.deepEqual(getEffectiveSoundSelection("completed"), {
    pack: "minimal",
    cue: "complete",
  });
  assert.deepEqual(getEffectiveSoundSelection("failed"), { pack: "minimal", cue: "error" });
  // 兼容读口仍可用。
  assert.equal(getEffectiveSoundCue("completed"), "complete");
});

test("v2 按行存对：四行可用不同风格", { concurrency: false }, () => {
  resetStorage();
  persistSystemSoundMap({
    completed: { pack: "glass", cue: "success" },
    failed: { pack: "arcade", cue: "error" },
  });
  assert.deepEqual(getEffectiveSoundSelection("completed"), {
    pack: "glass",
    cue: "success",
  });
  assert.deepEqual(getEffectiveSoundSelection("failed"), { pack: "arcade", cue: "error" });
  // 未覆盖的行仍取默认。
  assert.deepEqual(getEffectiveSoundSelection("permission_request"), {
    pack: "minimal",
    cue: "mention",
  });
  resetStorage();
});

test("v2 脏数据：非法对丢弃、未知版本与非 JSON 视为空", { concurrency: false }, () => {
  resetStorage();
  storage().setItem(
    "zcode-notification-sound-map",
    JSON.stringify({
      version: 2,
      completed: { pack: "glass", cue: "not-a-sound" },
      failed: { pack: "arcade", cue: "error" },
      bogus: { pack: "glass", cue: "success" },
    }),
  );
  assert.deepEqual(getEffectiveSoundSelection("completed"), {
    pack: "minimal",
    cue: "complete",
  });
  assert.deepEqual(getEffectiveSoundSelection("failed"), { pack: "arcade", cue: "error" });
  assert.deepEqual(getSystemSoundMap(), { failed: { pack: "arcade", cue: "error" } });

  storage().setItem("zcode-notification-sound-map", JSON.stringify({ version: 99 }));
  assert.deepEqual(getSystemSoundMap(), {});
  storage().setItem("zcode-notification-sound-map", "not-json");
  assert.deepEqual(getSystemSoundMap(), {});
  resetStorage();
});

test("v1 迁移：字符串映射按当时全局风格拼成对", { concurrency: false }, () => {
  resetStorage();
  storage().setItem("zcode-notification-sound-pack", "glass");
  storage().setItem(
    "zcode-notification-sound-map",
    JSON.stringify({ version: 1, completed: "success", failed: "not-a-sound" }),
  );
  // completed 沿用 glass + 原 cue；failed 的 cue 非法，整行回退默认。
  assert.deepEqual(getEffectiveSoundSelection("completed"), {
    pack: "glass",
    cue: "success",
  });
  assert.deepEqual(getEffectiveSoundSelection("failed"), { pack: "minimal", cue: "error" });

  // 全局键非法时按 minimal 迁移。
  resetStorage();
  storage().setItem("zcode-notification-sound-pack", "not-a-pack");
  storage().setItem(
    "zcode-notification-sound-map",
    JSON.stringify({ version: 1, completed: "success" }),
  );
  assert.deepEqual(getEffectiveSoundSelection("completed"), {
    pack: "minimal",
    cue: "success",
  });
  resetStorage();
});
