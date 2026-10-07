import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setDataBaseDir } from "../src/paths.js";
import {
  firstGraphemeOf,
  normalizeTaskGroupEmojiForRead,
  normalizeTaskGroupEmojiForWrite,
} from "../src/session/taskGroupEmoji.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

/**
 * 分组 emoji：归一化口径、0004 迁移、Repo 往返。
 * 行为见 docs/specs/task-group-emoji-and-row-tag.md。
 */

test("写前归一化：合法取首 grapheme，空串清除，无合法拒绝", () => {
  assert.equal(normalizeTaskGroupEmojiForWrite("🚀"), "🚀");
  assert.equal(normalizeTaskGroupEmojiForWrite("🚀abc"), "🚀");
  assert.equal(normalizeTaskGroupEmojiForWrite("🇨🇳"), "🇨🇳");
  assert.equal(normalizeTaskGroupEmojiForWrite("👨‍👩‍👧"), "👨‍👩‍👧");
  assert.equal(normalizeTaskGroupEmojiForWrite(""), "");
  assert.equal(normalizeTaskGroupEmojiForWrite("   "), "");
  assert.equal(normalizeTaskGroupEmojiForWrite("ab"), null);
  assert.equal(normalizeTaskGroupEmojiForWrite("a🚀"), null);
});

test("读侧兜底：脏值按空处理，只读不写", () => {
  assert.equal(normalizeTaskGroupEmojiForRead("🚀"), "🚀");
  assert.equal(normalizeTaskGroupEmojiForRead("🚀abc"), undefined);
  assert.equal(normalizeTaskGroupEmojiForRead("hello"), undefined);
  assert.equal(normalizeTaskGroupEmojiForRead(""), undefined);
  assert.equal(normalizeTaskGroupEmojiForRead(null), undefined);
  assert.equal(normalizeTaskGroupEmojiForRead(undefined), undefined);
});

test("首字兜底：Intl.Segmenter 首 grapheme", () => {
  assert.equal(firstGraphemeOf("分组一"), "分");
  assert.equal(firstGraphemeOf("  abc"), "a");
  assert.equal(firstGraphemeOf(""), "");
});

test("Repo 往返：创建带 emoji → 更新 → 清除 → 刷新后仍在", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-group-emoji-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    const group = await repo.createTaskGroup({ title: "表情组", emoji: "🚀" });
    assert.equal(group.emoji, "🚀");

    const updated = await repo.updateTaskGroupEmoji({ groupId: group.id, emoji: "🎯" });
    assert.equal(updated.emoji, "🎯");

    const cleared = await repo.updateTaskGroupEmoji({ groupId: group.id, emoji: "" });
    assert.equal(cleared.emoji, undefined);

    // 多字符输入非法，直接抛错不落库。
    await assert.rejects(() => repo.updateTaskGroupEmoji({ groupId: group.id, emoji: "ab" }));
    await assert.rejects(() => repo.createTaskGroup({ title: "坏组", emoji: "ab" }));
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("0004 迁移：老库无 emoji 列升级后读写正常", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-group-emoji-migrate-"));
  setDataBaseDir(dir);
  const dbPath = join(dir, "tasks.sqlite");
  // 模拟 0004 之前的库：建旧表结构（无 emoji 列），不写 migration 账本。
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE task_groups (
    group_id TEXT PRIMARY KEY, title TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'gray',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  legacy.exec(`INSERT INTO task_groups VALUES ('legacy-g', '老组', 'blue', 1, 2)`);
  legacy.close();

  const repo = new TaskIndexRepo(dbPath);
  try {
    // Repo 初始化触发迁移：读老行不崩，emoji 按空处理。
    const structure = await repo.queryGroupedTaskViewStructure({ workspaceScopes: [] });
    const legacyGroup = structure.groups.find((group) => group.id === "legacy-g");
    assert.ok(legacyGroup, "老分组应可读");
    assert.equal(legacyGroup.emoji, undefined);

    // 升级后可写 emoji。
    const updated = await repo.updateTaskGroupEmoji({ groupId: "legacy-g", emoji: "📌" });
    assert.equal(updated.emoji, "📌");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
