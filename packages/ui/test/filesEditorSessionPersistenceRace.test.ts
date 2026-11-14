import assert from "node:assert/strict";
import test from "node:test";
import { filesWorkspaceKey } from "../src/files-workbench/filesEditorBufferModel.js";
import { filesFileBufferId } from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorSessionPersistence } from "../src/files-workbench/filesEditorSessionPersistenceOwner.js";
import {
  createFilesTextDraftRecord,
  filesTextDraftPartChanges,
  filesTextDraftStorageKey,
  normalizeFilesTextDraftRecord,
  type FilesTextDraftRecord,
  type FilesTextDraftStorage,
} from "../src/files-workbench/filesTextDraftStorage.js";
import type {
  FilesEditorState,
  FilesPersistedDraft,
  FilesPersistedSession,
  FilesTextBuffer,
  FilesTextDocumentBinding,
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";

const WORKSPACE_A: FilesWorkspaceRef = {
  workspacePath: "/workspace",
  workspaceIdentity: "ws-a",
  workspaceRemoteSessionId: "remote-a",
};
const WORKSPACE_B: FilesWorkspaceRef = {
  workspacePath: "/workspace",
  workspaceIdentity: "ws-a",
  workspaceRemoteSessionId: "remote-b",
};
const WORKSPACE_C: FilesWorkspaceRef = {
  workspacePath: "/workspace",
  workspaceIdentity: "ws-c",
  workspaceRemoteSessionId: "remote-a",
};

function storageKeyFor(draft: FilesPersistedDraft): string {
  return filesTextDraftStorageKey({
    workspaceKey: filesWorkspaceKey(draft.workspace),
    remoteSessionId: draft.workspace.workspaceRemoteSessionId?.trim() ?? "",
    path: draft.path,
    bufferId: draft.id,
  });
}

function draftFor(params: {
  path: string;
  text: string;
  workspace?: FilesWorkspaceRef;
  updatedAt?: number;
}): FilesPersistedDraft {
  const workspace = params.workspace ?? WORKSPACE_A;
  return {
    id: filesFileBufferId(workspace, params.path),
    path: params.path,
    title: params.path.split("/").at(-1) ?? params.path,
    text: params.text,
    savedText: "saved",
    workspace,
    untitled: false,
    ...(params.updatedAt === undefined ? undefined : { updatedAt: params.updatedAt }),
  };
}

function textBufferFor(draft: FilesPersistedDraft, text = draft.text): FilesTextBuffer {
  return {
    id: draft.id,
    kind: "text",
    path: draft.path!,
    title: draft.title,
    text,
    savedText: draft.savedText,
    workspace: draft.workspace,
    untitled: false,
  };
}

function fakeTextDocument(initialText: string) {
  let text = initialText;
  let versionId = 1;
  let disposed = false;
  let reads = 0;
  const binding: FilesTextDocumentBinding = {
    getText: () => {
      reads += 1;
      return text;
    },
    getVersionId: () => versionId,
    replaceText: (next) => {
      text = next;
      versionId += 1;
    },
    getFirstLine: (maxLength) => {
      const newline = text.indexOf("\n");
      return text.slice(0, Math.min(newline < 0 ? text.length : newline, maxLength ?? text.length));
    },
    getLength: () => text.length,
    isDisposed: () => disposed,
  };
  return {
    binding,
    get reads() {
      return reads;
    },
    get versionId() {
      return versionId;
    },
    type(next: string) {
      text = next;
      versionId += 1;
    },
    dispose() {
      disposed = true;
    },
  };
}

function stateWithBuffers(buffers: FilesTextBuffer[]): FilesEditorState {
  return {
    explorerWorkspaceKey: filesWorkspaceKey(buffers[0]?.workspace ?? WORKSPACE_A),
    activeId: buffers[0]?.id,
    openIds: buffers.map((buffer) => buffer.id),
    buffers,
  } as unknown as FilesEditorState;
}

function sessionWithDrafts(drafts: FilesPersistedDraft[]): FilesPersistedSession {
  return {
    version: 1,
    activeId: drafts[0]?.id,
    openFileIds: drafts.map((draft) => draft.id),
    openTabs: drafts.map((draft) => ({
      id: draft.id,
      kind: "text" as const,
      path: draft.path,
      workspace: draft.workspace,
    })),
    drafts,
  };
}

function sessionWithTabsOnly(drafts: FilesPersistedDraft[]): FilesPersistedSession {
  return {
    ...sessionWithDrafts(drafts),
    drafts: [],
  };
}

function memoryStorage() {
  const items = new Map<string, string>();
  let writes = 0;
  return {
    items,
    get writes() {
      return writes;
    },
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
      writes += 1;
    },
  };
}

class MemoryDraftStorage implements FilesTextDraftStorage {
  readonly records = new Map<string, FilesTextDraftRecord>();
  readonly deleted: string[] = [];
  readonly saves: FilesTextDraftRecord[] = [];

  async load(storageKey: string) {
    return this.records.get(storageKey);
  }

  async save(record: FilesTextDraftRecord) {
    this.saves.push(record);
    this.records.set(record.storageKey, record);
  }

  async delete(storageKey: string) {
    this.deleted.push(storageKey);
    this.records.delete(storageKey);
  }
}

interface PendingSave {
  record: FilesTextDraftRecord;
  resolve: () => void;
  reject: (error: unknown) => void;
}

class DeferredDraftStorage implements FilesTextDraftStorage {
  readonly records = new Map<string, FilesTextDraftRecord>();
  readonly saves: PendingSave[] = [];
  readonly deleted: string[] = [];

  async load(storageKey: string) {
    return this.records.get(storageKey);
  }

  save(record: FilesTextDraftRecord) {
    return new Promise<void>((resolve, reject) => {
      this.saves.push({ record, resolve, reject });
    });
  }

  async delete(storageKey: string) {
    this.deleted.push(storageKey);
    this.records.delete(storageKey);
  }

  resolveNext(): void {
    const next = this.saves.shift();
    assert.ok(next, "预期存在在途 save");
    this.records.set(next.record.storageKey, next.record);
    next.resolve();
  }

  rejectNext(error: unknown): void {
    const next = this.saves.shift();
    assert.ok(next, "预期存在在途 save");
    next.reject(error);
  }
}

class FlakyDraftStorage extends MemoryDraftStorage {
  attempts = 0;

  override async save(record: FilesTextDraftRecord) {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("indexeddb-write-failed");
    }
    await super.save(record);
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`等待超时: ${label}`);
}

function bigText(tag: string): string {
  return "x".repeat(1_500_000) + tag;
}

test("save 在途时草稿变干净：flush 后不得残留未完成写入的旧记录", async () => {
  const draft = draftFor({ path: "/workspace/race-clean.txt", text: bigText("v1") });
  const buffer = textBufferFor(draft);
  let state = stateWithBuffers([buffer]);
  const storage = memoryStorage();
  const draftStorage = new DeferredDraftStorage();
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage,
    draftStorage,
    now: () => 10,
    debounceMs: 0,
    log: { warn: () => undefined },
  });
  const storageKey = storageKeyFor(draft);

  persistence.persist();
  await waitFor(() => draftStorage.saves.length === 1, "IndexedDB save 启动");
  assert.equal(draftStorage.saves[0]?.record.text, bigText("v1"));

  // save 仍在途时用户把草稿改回已保存状态。
  state = stateWithBuffers([textBufferFor(draft, draft.savedText)]);
  persistence.persist();
  const flushing = persistence.flush();
  draftStorage.resolveNext();
  await flushing;

  assert.deepEqual(draftStorage.deleted, [storageKey]);
  assert.equal(draftStorage.records.has(storageKey), false);
});

test("save 在途时标签关闭：flush 后不得残留未完成写入的旧记录", async () => {
  const draft = draftFor({ path: "/workspace/race-close.txt", text: bigText("v1") });
  const buffer = textBufferFor(draft);
  let state = stateWithBuffers([buffer]);
  const draftStorage = new DeferredDraftStorage();
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage: memoryStorage(),
    draftStorage,
    now: () => 11,
    debounceMs: 0,
    log: { warn: () => undefined },
  });
  const storageKey = storageKeyFor(draft);

  persistence.persist();
  await waitFor(() => draftStorage.saves.length === 1, "IndexedDB save 启动");

  state = stateWithBuffers([]);
  persistence.persist();
  const flushing = persistence.flush();
  draftStorage.resolveNext();
  await flushing;

  assert.deepEqual(draftStorage.deleted, [storageKey]);
  assert.equal(draftStorage.records.has(storageKey), false);
});

test("连续更新时只有最后一次 desired 正文胜出", async () => {
  const draft = draftFor({ path: "/workspace/race-newer.txt", text: bigText("v1") });
  const buffer = textBufferFor(draft);
  let state = stateWithBuffers([buffer]);
  const draftStorage = new DeferredDraftStorage();
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage: memoryStorage(),
    draftStorage,
    now: () => 12,
    debounceMs: 0,
    log: { warn: () => undefined },
  });
  const storageKey = storageKeyFor(draft);

  persistence.persist();
  await waitFor(() => draftStorage.saves.length === 1, "第一次 save 启动");
  assert.equal(draftStorage.saves[0]?.record.text, bigText("v1"));

  state = stateWithBuffers([textBufferFor(draft, bigText("v2"))]);
  persistence.persist();
  state = stateWithBuffers([textBufferFor(draft, bigText("v3"))]);
  persistence.persist();

  const flushing = persistence.flush();
  draftStorage.resolveNext();
  await waitFor(() => draftStorage.saves.length === 1, "最新一次 save 启动");
  assert.equal(draftStorage.saves[0]?.record.text, bigText("v3"));
  draftStorage.resolveNext();
  await flushing;

  assert.equal(draftStorage.records.get(storageKey)?.text, bigText("v3"));
  assert.equal(draftStorage.records.size, 1);
});

test("save 在途时内容未变的 persist 不会重复写同一条记录", async () => {
  const draft = draftFor({ path: "/workspace/race-unchanged.txt", text: bigText("v1") });
  const state = stateWithBuffers([textBufferFor(draft)]);
  const draftStorage = new DeferredDraftStorage();
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage: memoryStorage(),
    draftStorage,
    now: () => 12,
    debounceMs: 0,
    log: { warn: () => undefined },
  });

  persistence.persist();
  await waitFor(() => draftStorage.saves.length === 1, "第一次 save 启动");
  persistence.persist();

  const flushing = persistence.flush();
  draftStorage.resolveNext();
  await flushing;

  assert.equal(draftStorage.saves.length, 0);
  assert.equal(draftStorage.records.size, 1);
  assert.deepEqual(draftStorage.deleted, []);
});

test("localStorage 同 id 草稿不早于 IndexedDB 时胜出并清理旧记录", async () => {
  const local = draftFor({
    path: "/workspace/authority-local.txt",
    text: "local newest",
    updatedAt: 20,
  });
  const stale = draftFor({
    path: "/workspace/authority-local.txt",
    text: "stale indexeddb",
    updatedAt: 5,
  });
  const storage = memoryStorage();
  storage.items.set("zcode-files-editor-session-v1", JSON.stringify(sessionWithDrafts([local])));
  const draftStorage = new MemoryDraftStorage();
  const staleRecord = createFilesTextDraftRecord(stale, 5);
  draftStorage.records.set(staleRecord.storageKey, staleRecord);
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => stateWithBuffers([]) },
    storage,
    draftStorage,
    debounceMs: 0,
    log: { warn: () => undefined },
  });

  const loaded = await persistence.load();

  assert.ok(loaded);
  assert.equal(loaded.drafts[0]?.text, "local newest");
  await persistence.flush();
  assert.deepEqual(draftStorage.deleted, [staleRecord.storageKey]);
  assert.equal(draftStorage.records.has(staleRecord.storageKey), false);
});

test("旧 localStorage 会话缺少 epoch 时按本地优先并清理旧 IndexedDB 记录", async () => {
  const local = draftFor({ path: "/workspace/authority-legacy.txt", text: "legacy local" });
  const stale = draftFor({
    path: "/workspace/authority-legacy.txt",
    text: "legacy indexeddb",
    updatedAt: 99,
  });
  const storage = memoryStorage();
  storage.items.set("zcode-files-editor-session-v1", JSON.stringify(sessionWithDrafts([local])));
  const draftStorage = new MemoryDraftStorage();
  const staleRecord = createFilesTextDraftRecord(stale, 99);
  draftStorage.records.set(staleRecord.storageKey, staleRecord);
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => stateWithBuffers([]) },
    storage,
    draftStorage,
    debounceMs: 0,
    log: { warn: () => undefined },
  });

  const loaded = await persistence.load();

  assert.ok(loaded);
  assert.equal(loaded.drafts[0]?.text, "legacy local");
  await persistence.flush();
  assert.equal(draftStorage.records.has(staleRecord.storageKey), false);
});

test("localStorage 只有标签元数据时恢复 IndexedDB 大草稿且不删除", async () => {
  const tabDraft = draftFor({ path: "/workspace/authority-big.txt", text: "", updatedAt: 30 });
  const big = draftFor({
    path: "/workspace/authority-big.txt",
    text: "big indexeddb body",
    updatedAt: 30,
  });
  const storage = memoryStorage();
  storage.items.set(
    "zcode-files-editor-session-v1",
    JSON.stringify(sessionWithTabsOnly([tabDraft])),
  );
  const draftStorage = new MemoryDraftStorage();
  const record = createFilesTextDraftRecord(big, 30);
  draftStorage.records.set(record.storageKey, record);
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
  assert.equal(loaded.drafts[0]?.text, "big indexeddb body");
  await persistence.flush();
  assert.equal(draftStorage.records.has(record.storageKey), true);
  assert.deepEqual(draftStorage.deleted, []);
});

test("load 命中的记录即使内容未变，首次 persist 也会 save 一次以校验/拆分 v3", async () => {
  const draft = draftFor({
    path: "/workspace/loaded-unverified.txt",
    text: "x".repeat(1_500_000),
    updatedAt: 30,
  });
  const storage = memoryStorage();
  storage.items.set("zcode-files-editor-session-v1", JSON.stringify(sessionWithTabsOnly([draft])));
  const record = createFilesTextDraftRecord(draft, 30);
  const draftStorage = new MemoryDraftStorage();
  draftStorage.records.set(record.storageKey, record);
  const state = stateWithBuffers([textBufferFor(draft)]);
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage,
    draftStorage,
    debounceMs: 0,
    log: { warn: () => undefined },
  });

  const loaded = await persistence.load();

  assert.ok(loaded);
  assert.equal(draftStorage.saves.length, 0);

  // 内容与 revision 都没变，但 load 只证明整条可读；v2 记录必须在这里被拆分。
  persistence.persist();
  await persistence.flush();

  assert.equal(draftStorage.saves.length, 1);
  assert.equal(draftStorage.saves[0]?.storageKey, record.storageKey);
  assert.equal(draftStorage.saves[0]?.bodyRevision, record.bodyRevision);
  assert.equal(draftStorage.saves[0]?.savedRevision, record.savedRevision);
});

test("大草稿缩小回 localStorage 后清理 IndexedDB，崩溃残留的旧记录也不会复活", async () => {
  const big = draftFor({ path: "/workspace/shrink.txt", text: "x".repeat(1_500_000) });
  const bigBuffer = textBufferFor(big);
  let state = stateWithBuffers([bigBuffer]);
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
  const storageKey = storageKeyFor(big);

  persistence.persist();
  await persistence.flush();
  assert.equal(draftStorage.records.has(storageKey), true);

  // 草稿缩小后进入 localStorage，IndexedDB 必须删除。
  const small = { ...big, text: "small now" };
  state = stateWithBuffers([textBufferFor(small, "small now")]);
  persistence.persist();
  await persistence.flush();
  assert.equal(draftStorage.records.has(storageKey), false);

  // 模拟上次删除前崩溃：IndexedDB 仍留有更旧记录；本地 epoch 更新时不得复活。
  const staleRecord = createFilesTextDraftRecord(small, 1);
  draftStorage.records.set(storageKey, staleRecord);
  const loaded = await persistence.load();
  assert.ok(loaded);
  assert.equal(loaded.drafts[0]?.text, "small now");
  await persistence.flush();
  assert.equal(draftStorage.records.has(storageKey), false);
});

test("IndexedDB 写入失败只记录 warning，后续 persist 仍可重试", async () => {
  const draft = draftFor({ path: "/workspace/write-failure.txt", text: "x".repeat(1_500_000) });
  const state = stateWithBuffers([textBufferFor(draft)]);
  const draftStorage = new FlakyDraftStorage();
  const warnings: unknown[] = [];
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage: memoryStorage(),
    draftStorage,
    now: () => 13,
    debounceMs: 0,
    log: { warn: (_message, context) => warnings.push(context) },
  });
  const storageKey = storageKeyFor(draft);

  persistence.persist();
  await persistence.flush();
  assert.equal(draftStorage.records.has(storageKey), false);
  assert.equal(warnings.length, 1);

  persistence.persist();
  await persistence.flush();
  assert.equal(draftStorage.records.has(storageKey), true);
  assert.equal(draftStorage.attempts, 2);
});

test("不同 remoteSessionId / storageKey 的草稿不会互相恢复或删除", async () => {
  const local = draftFor({
    path: "/workspace/isolated.txt",
    text: "local owner",
    updatedAt: 20,
  });
  const foreign = draftFor({
    path: "/workspace/isolated.txt",
    text: "foreign remote body",
    workspace: WORKSPACE_B,
    updatedAt: 99,
  });
  const localStale = draftFor({
    path: "/workspace/isolated.txt",
    text: "stale same owner",
    updatedAt: 3,
  });
  const foreignIdentity = draftFor({
    path: "/workspace/isolated.txt",
    text: "foreign workspace body",
    workspace: WORKSPACE_C,
    updatedAt: 98,
  });
  const storage = memoryStorage();
  storage.items.set("zcode-files-editor-session-v1", JSON.stringify(sessionWithDrafts([local])));
  const draftStorage = new MemoryDraftStorage();
  const localStaleRecord = createFilesTextDraftRecord(localStale, 3);
  const foreignRecord = createFilesTextDraftRecord(foreign, 99);
  const foreignIdentityRecord = createFilesTextDraftRecord(foreignIdentity, 98);
  draftStorage.records.set(localStaleRecord.storageKey, localStaleRecord);
  draftStorage.records.set(foreignRecord.storageKey, foreignRecord);
  draftStorage.records.set(foreignIdentityRecord.storageKey, foreignIdentityRecord);
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => stateWithBuffers([]) },
    storage,
    draftStorage,
    debounceMs: 0,
    log: { warn: () => undefined },
  });

  const loaded = await persistence.load();

  assert.ok(loaded);
  assert.equal(loaded.drafts[0]?.text, "local owner");
  await persistence.flush();
  assert.equal(draftStorage.records.has(localStaleRecord.storageKey), false);
  assert.equal(draftStorage.records.has(foreignRecord.storageKey), true);
  assert.equal(draftStorage.records.has(foreignIdentityRecord.storageKey), true);
  assert.deepEqual(draftStorage.deleted, [localStaleRecord.storageKey]);
});

test("只有标签元数据时也不会按其它 remoteSessionId 的 storageKey 恢复", async () => {
  const tab = draftFor({ path: "/workspace/isolated-tab.txt", text: "", updatedAt: 20 });
  const own = draftFor({
    path: "/workspace/isolated-tab.txt",
    text: "own body",
    updatedAt: 20,
  });
  const foreign = draftFor({
    path: "/workspace/isolated-tab.txt",
    text: "foreign body",
    workspace: WORKSPACE_B,
    updatedAt: 20,
  });
  const storage = memoryStorage();
  storage.items.set("zcode-files-editor-session-v1", JSON.stringify(sessionWithTabsOnly([tab])));
  const draftStorage = new MemoryDraftStorage();
  const ownRecord = createFilesTextDraftRecord(own, 20);
  const foreignRecord = createFilesTextDraftRecord(foreign, 20);
  draftStorage.records.set(ownRecord.storageKey, ownRecord);
  draftStorage.records.set(foreignRecord.storageKey, foreignRecord);
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
  assert.equal(loaded.drafts[0]?.text, "own body");
  assert.equal(draftStorage.records.has(foreignRecord.storageKey), true);
});

test("连续局部输入只累代次，不读正文也不写存储；flush 只快照一次", async () => {
  const draft = draftFor({ path: "/workspace/per-key.txt", text: bigText("v1") });
  const document = fakeTextDocument(draft.text);
  const buffer: FilesTextBuffer = {
    ...textBufferFor(draft),
    document: document.binding,
    savedDocumentVersionId: 0,
    documentRevision: 1,
  };
  const state = stateWithBuffers([buffer]);
  const storage = memoryStorage();
  const draftStorage = new MemoryDraftStorage();
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage,
    draftStorage,
    now: () => 40,
    debounceMs: 0,
    textPersistDebounceMs: 5_000,
    log: { warn: () => undefined },
  });

  for (let index = 0; index < 20; index += 1) persistence.noteTextChange();

  // 逐键路径不得触发全文 getText / localStorage / IndexedDB。
  assert.equal(document.reads, 0);
  assert.equal(storage.writes, 0);
  assert.equal(draftStorage.saves.length, 0);

  await persistence.flush();

  assert.equal(document.reads, 1);
  assert.equal(storage.writes, 1);
  assert.equal(draftStorage.saves.length, 1);
  assert.equal(draftStorage.saves[0]?.text, draft.text);
});

test("内容未变不重写 IndexedDB；仅正文或仅基线变化时只推进对应 revision", async () => {
  const draft = draftFor({ path: "/workspace/revision-dedup.txt", text: bigText("v1") });
  const document = fakeTextDocument(draft.text);
  const baseBuffer: FilesTextBuffer = {
    ...textBufferFor(draft),
    document: document.binding,
    savedDocumentVersionId: 0,
    documentRevision: 1,
  };
  let state = stateWithBuffers([baseBuffer]);
  const draftStorage = new MemoryDraftStorage();
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage: memoryStorage(),
    draftStorage,
    now: () => 41,
    debounceMs: 0,
    textPersistDebounceMs: 0,
    log: { warn: () => undefined },
  });

  persistence.persist();
  await persistence.flush();
  assert.equal(draftStorage.saves.length, 1);
  const first = draftStorage.saves[0]!;
  // 真实 IDB 里 drafts 只存元数据，正文与基线在独立 store；这里按同样形态传入。
  const storedParts = (record: FilesTextDraftRecord) => ({
    schemaVersion: record.schemaVersion,
    bodyRevision: record.bodyRevision,
    savedRevision: record.savedRevision,
  });

  // 同一正文与基线再次 persist：owner 不应重复调用 save。
  persistence.persist();
  await persistence.flush();
  assert.equal(draftStorage.saves.length, 1);

  document.type(bigText("v2"));
  state = stateWithBuffers([{ ...baseBuffer, documentRevision: 2 }]);
  persistence.persist();
  await persistence.flush();
  assert.equal(draftStorage.saves.length, 2);
  const second = draftStorage.saves[1]!;
  assert.notEqual(second.bodyRevision, first.bodyRevision);
  assert.equal(second.savedRevision, first.savedRevision);
  assert.deepEqual(filesTextDraftPartChanges(storedParts(first), second), {
    body: true,
    baseline: false,
  });

  // 只有已保存基线变化：正文 revision 不动，baseline revision 推进。
  state = stateWithBuffers([
    {
      ...baseBuffer,
      documentRevision: 2,
      savedDocumentVersionId: 9,
      savedText: "saved v2",
    },
  ]);
  persistence.persist();
  await persistence.flush();
  assert.equal(draftStorage.saves.length, 3);
  const third = draftStorage.saves[2]!;
  assert.equal(third.bodyRevision, second.bodyRevision);
  assert.notEqual(third.savedRevision, second.savedRevision);
  assert.deepEqual(filesTextDraftPartChanges(storedParts(second), third), {
    body: false,
    baseline: true,
  });
});

test("运行时版本号与本地 revision 撞号时，正文变化仍推进 revision", async () => {
  const draft = draftFor({ path: "/workspace/revision-collision.txt", text: bigText("v1") });
  const baseBuffer = textBufferFor(draft);
  let state = stateWithBuffers([baseBuffer]);
  const draftStorage = new MemoryDraftStorage();
  const persistence = createFilesEditorSessionPersistence({
    store: { getState: () => state },
    storage: memoryStorage(),
    draftStorage,
    now: () => 42,
    debounceMs: 0,
    textPersistDebounceMs: 0,
    log: { warn: () => undefined },
  });

  persistence.persist();
  await persistence.flush();
  const first = draftStorage.saves[0]!;
  assert.equal(first.bodyRevision, 1);

  // 新绑定文档的 documentRevision 恰好等于旧本地 revision，但正文已经变化。
  const document = fakeTextDocument(bigText("v2"));
  state = stateWithBuffers([
    {
      ...baseBuffer,
      document: document.binding,
      documentRevision: first.bodyRevision,
      savedDocumentVersionId: 0,
    },
  ]);
  persistence.persist();
  await persistence.flush();

  assert.equal(draftStorage.saves.length, 2);
  const second = draftStorage.saves[1]!;
  assert.ok(second.bodyRevision > first.bodyRevision);
  assert.equal(second.text, bigText("v2"));
});

test("v3 只按 revision 拆分正文/基线；v2 全量记录首次保存强制拆分", () => {
  const draft = draftFor({ path: "/workspace/legacy-parts.txt", text: "body" });
  const current = createFilesTextDraftRecord(draft, 10, {
    bodyRevision: 4,
    savedRevision: 2,
  });
  // v3 的 drafts store 里只有这些字段；正文/基线在独立 store。
  const currentParts = {
    schemaVersion: current.schemaVersion,
    bodyRevision: current.bodyRevision,
    savedRevision: current.savedRevision,
  };

  assert.deepEqual(filesTextDraftPartChanges(currentParts, { bodyRevision: 5, savedRevision: 2 }), {
    body: true,
    baseline: false,
  });
  assert.deepEqual(filesTextDraftPartChanges(currentParts, { bodyRevision: 4, savedRevision: 3 }), {
    body: false,
    baseline: true,
  });
  assert.deepEqual(filesTextDraftPartChanges(currentParts, { bodyRevision: 4, savedRevision: 2 }), {
    body: false,
    baseline: false,
  });

  // metadata revision 未变但 part store 缺失：save 必须补写对应 part，
  // 否则 load 会一直报 draft-parts-missing。
  assert.deepEqual(
    filesTextDraftPartChanges(
      currentParts,
      { bodyRevision: 4, savedRevision: 2 },
      {
        body: false,
        baseline: true,
      },
    ),
    { body: true, baseline: false },
  );
  assert.deepEqual(
    filesTextDraftPartChanges(
      currentParts,
      { bodyRevision: 4, savedRevision: 2 },
      {
        body: true,
        baseline: false,
      },
    ),
    { body: false, baseline: true },
  );
  assert.deepEqual(
    filesTextDraftPartChanges(
      currentParts,
      { bodyRevision: 4, savedRevision: 2 },
      {
        body: false,
        baseline: false,
      },
    ),
    { body: true, baseline: true },
  );

  const legacy = { ...current, schemaVersion: 2 };
  assert.deepEqual(filesTextDraftPartChanges(legacy, { bodyRevision: 4, savedRevision: 2 }), {
    body: true,
    baseline: true,
  });
  const normalized = normalizeFilesTextDraftRecord(legacy);
  assert.ok(normalized);
  assert.equal(normalized.bodyRevision, 10);
  assert.equal(normalized.savedRevision, 10);
});
