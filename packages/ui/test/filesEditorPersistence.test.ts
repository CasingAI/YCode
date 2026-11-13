import assert from "node:assert/strict";
import test from "node:test";
import {
  readFilesEditorSession,
  splitFilesEditorSessionForStorage,
  writeFilesEditorSession,
} from "../src/files-workbench/filesEditorPersistence.js";
import { createFilesEditorSessionPersistence } from "../src/files-workbench/filesEditorSessionPersistenceOwner.js";
import { filesFileBufferId } from "../src/files-workbench/filesEditorModel.js";
import type {
  FilesEditorState,
  FilesPersistedDraft,
  FilesPersistedSession,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";
import type {
  FilesTextDraftRecord,
  FilesTextDraftStorage,
} from "../src/files-workbench/filesTextDraftStorage.js";
import {
  createFilesTextDraftRecord,
  filesTextDraftStorageKey,
} from "../src/files-workbench/filesTextDraftStorage.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/workspace" };

function draft(id: string, text: string, updatedAt?: number): FilesPersistedDraft {
  return {
    id,
    path: `/workspace/${id}.txt`,
    title: `${id}.txt`,
    text,
    savedText: "saved",
    workspace,
    untitled: false,
    ...(updatedAt === undefined ? undefined : { updatedAt }),
  };
}

function sessionWithDrafts(drafts: FilesPersistedDraft[]): FilesPersistedSession {
  return {
    version: 1,
    activeId: drafts[0]?.id,
    openFileIds: drafts.map((entry) => entry.id),
    openTabs: drafts.map((entry) => ({
      id: entry.id,
      kind: "text" as const,
      path: entry.path,
      workspace,
    })),
    drafts,
  };
}

function textBuffer(id: string, text: string, savedText: string): FilesTextBuffer {
  return {
    id,
    kind: "text",
    path: `/workspace/${id}.txt`,
    title: `${id}.txt`,
    text,
    savedText,
    workspace,
    untitled: false,
  };
}

function stateWithBuffers(buffers: FilesTextBuffer[]): FilesEditorState {
  return {
    explorerWorkspaceKey: "/workspace",
    activeId: buffers[0]?.id,
    openIds: buffers.map((buffer) => buffer.id),
    buffers,
  } as unknown as FilesEditorState;
}

class MemoryDraftStorage implements FilesTextDraftStorage {
  readonly records = new Map<string, FilesTextDraftRecord>();
  readonly deleted: string[] = [];

  async load(storageKey: string) {
    return this.records.get(storageKey);
  }

  async save(record: FilesTextDraftRecord) {
    this.records.set(record.storageKey, record);
  }

  async delete(storageKey: string) {
    this.deleted.push(storageKey);
    this.records.delete(storageKey);
  }
}

function memoryStorage(limit?: number) {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (limit !== undefined && value.length > limit) {
        throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
      }
      items.set(key, value);
    },
  };
}

test("恢复旧会话时将重复标签 ID 归一化，避免重复创建编辑器视图", () => {
  const id = filesFileBufferId(workspace, "/workspace/src/hostCapability.ts");
  const tab = { id, kind: "text" as const, path: "/workspace/src/hostCapability.ts", workspace };
  const raw = JSON.stringify({
    version: 1,
    activeId: id,
    openFileIds: Array.from({ length: 103 }, () => id),
    openTabs: Array.from({ length: 103 }, () => tab),
    drafts: [],
  });
  const session = readFilesEditorSession({ getItem: () => raw, setItem: () => undefined });

  assert.ok(session);
  assert.deepEqual(session.openFileIds, [id]);
  assert.deepEqual(
    session.openTabs.map((entry) => entry.id),
    [id],
  );
  assert.equal(session.activeId, id);
});

test("恢复会话时丢弃没有对应标签或草稿的 ID，并保留未列入 openFileIds 的脏草稿", () => {
  const id = filesFileBufferId(workspace, "/workspace/src/dirty.ts");
  const raw = JSON.stringify({
    version: 1,
    activeId: "file:missing",
    openFileIds: ["file:missing", id, id],
    openTabs: [],
    drafts: [
      {
        id,
        path: "/workspace/src/dirty.ts",
        title: "dirty.ts",
        text: "unsaved",
        savedText: "saved",
        workspace,
        untitled: false,
      },
    ],
  });
  const session = readFilesEditorSession({ getItem: () => raw, setItem: () => undefined });

  assert.ok(session);
  assert.deepEqual(session.openFileIds, [id]);
  assert.equal(session.activeId, id);
  assert.equal(session.drafts.length, 1);
});

test("按本地预算把单草稿与超总预算的草稿分流到 IndexedDB", () => {
  const large = draft("large", "x".repeat(1_500_000));
  const smallA = draft("a", "a".repeat(600_000));
  const smallB = draft("b", "b".repeat(600_000));
  const split = splitFilesEditorSessionForStorage(sessionWithDrafts([large, smallA, smallB]), {
    singleDraftMaxChars: 1_000_000,
    totalDraftMaxChars: 1_000_000,
  });

  // 单个超大草稿先移出；剩余仍超总预算时从最大的继续移出。
  assert.deepEqual(
    split.overflowDrafts.map((entry) => entry.id),
    ["large", "a"],
  );
  assert.deepEqual(
    split.session.drafts.map((entry) => entry.id),
    ["b"],
  );
});

test("localStorage 配额失败时移出最大草稿重试，并返回待 IndexedDB 备份的草稿", () => {
  const first = draft("first", "x".repeat(400));
  const second = draft("second", "y".repeat(1500));
  const storage = memoryStorage(1000);
  const result = writeFilesEditorSession(sessionWithDrafts([first, second]), storage);

  assert.equal(result.status, "written");
  assert.deepEqual(
    result.overflowDrafts.map((entry) => entry.id),
    ["second"],
  );
  const saved = JSON.parse(storage.items.get("zcode-files-editor-session-v1")!);
  assert.deepEqual(
    saved.drafts.map((entry: FilesPersistedDraft) => entry.id),
    ["first"],
  );
});

test("localStorage 始终配额失败时返回 quota，而非静默丢弃草稿", () => {
  const storage = memoryStorage(-1);
  const result = writeFilesEditorSession(sessionWithDrafts([draft("only", "text")]), storage);

  assert.equal(result.status, "quota");
  assert.deepEqual(
    result.overflowDrafts.map((entry) => entry.id),
    ["only"],
  );
});

test("没有 localStorage 时所有完整文本草稿都转交 IndexedDB", () => {
  const result = writeFilesEditorSession(
    sessionWithDrafts([draft("small", "a"), draft("big", "b".repeat(1_500_000))]),
    undefined,
  );

  assert.equal(result.status, "unavailable");
  assert.deepEqual(
    result.overflowDrafts.map((entry) => entry.id),
    ["small", "big"],
  );
});

test("大草稿写入 IndexedDB，localStorage 只保留标签与小草稿", async () => {
  const bigId = filesFileBufferId(workspace, "/workspace/big.txt");
  const smallId = filesFileBufferId(workspace, "/workspace/small.txt");
  let state = stateWithBuffers([
    textBuffer(bigId, "x".repeat(1_500_000), "saved"),
    textBuffer(smallId, "small draft", "saved"),
  ]);
  const storage = memoryStorage();
  const draftStorage = new MemoryDraftStorage();
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage,
    draftStorage,
    now: () => 7,
    debounceMs: 0,
    log: { warn: () => undefined },
  });

  persistence.persist();
  await persistence.flush();

  const session = JSON.parse(storage.items.get("zcode-files-editor-session-v1")!);
  assert.deepEqual(
    session.drafts.map((entry: FilesPersistedDraft) => entry.id),
    [smallId],
  );
  const storageKey = filesTextDraftStorageKey({
    workspaceKey: "/workspace",
    remoteSessionId: "",
    path: `/workspace/${bigId}.txt`,
    bufferId: bigId,
  });
  const record = draftStorage.records.get(storageKey);
  assert.ok(record);
  assert.equal(record.bufferId, bigId);
  assert.equal(record.text.length, 1_500_000);
  assert.equal(record.updatedAt, 7);

  // 草稿回到已保存状态后必须清理 IndexedDB，避免下次恢复出旧正文。
  state = stateWithBuffers([
    textBuffer(bigId, "saved", "saved"),
    textBuffer(smallId, "small draft", "saved"),
  ]);
  persistence.persist();
  await persistence.flush();
  assert.deepEqual(draftStorage.deleted, [storageKey]);
  assert.equal(draftStorage.records.has(storageKey), false);
});

test("IndexedDB 草稿 epoch 更新时覆盖 localStorage 中的同 ID 旧草稿", async () => {
  const id = filesFileBufferId(workspace, "/workspace/restored.txt");
  const localSession = sessionWithDrafts([draft(id, "stale local", 5)]);
  const storage = memoryStorage();
  storage.items.set("zcode-files-editor-session-v1", JSON.stringify(localSession));
  const draftStorage = new MemoryDraftStorage();
  const remoteDraft = draft(id, "latest indexeddb body", 9);
  const remoteRecord = createFilesTextDraftRecord(remoteDraft, 9);
  draftStorage.records.set(remoteRecord.storageKey, remoteRecord);
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => stateWithBuffers([]) },
    storage,
    draftStorage,
    debounceMs: 0,
    log: { warn: () => undefined },
  });

  const loaded = await persistence.load();

  assert.ok(loaded);
  assert.equal(loaded.drafts.length, 1);
  assert.equal(loaded.drafts[0]?.text, "latest indexeddb body");
  await persistence.flush();
  // IndexedDB 更新时必须保留，不能被当成旧记录删除。
  assert.equal(draftStorage.records.has(remoteRecord.storageKey), true);
  assert.deepEqual(draftStorage.deleted, []);
});

test("localStorage 会话缺少也没有 IndexedDB 记录时返回 undefined", async () => {
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => stateWithBuffers([]) },
    storage: memoryStorage(),
    draftStorage: new MemoryDraftStorage(),
    debounceMs: 0,
    log: { warn: () => undefined },
  });

  assert.equal(await persistence.load(), undefined);
});
