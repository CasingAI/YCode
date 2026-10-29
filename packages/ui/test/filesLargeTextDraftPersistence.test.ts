import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_LARGE_TEXT_DRAFT_SCHEMA_VERSION,
  FilesLargeTextDraftStorageError,
  filesLargeTextDraftOwner,
  filesLargeTextDraftStorageKey,
  type FilesDraftBuffer,
  type FilesLargeTextDraftRecord,
  type FilesLargeTextDraftStorage,
  type FilesLargeTextDraftProbeResult,
} from "../src/files-workbench/filesLargeTextDraftStorage.js";
import { createFilesLargeTextDraftPersistence } from "../src/files-workbench/filesLargeTextDraftPersistence.js";
import {
  createLargeTextFileBuffer,
  createPreviewBuffer,
  createTextFileBuffer,
} from "../src/files-workbench/filesEditorBufferModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import { filesLargeTextBlockIndex } from "../src/files-workbench/filesLargeTextBlockModel.js";
import type {
  FilesEditorState,
  FilesLargeTextBuffer,
} from "../src/files-workbench/filesEditorTypes.js";

const workspace = { workspacePath: "/tmp/ws" };
const path = "/tmp/ws/big.txt";
const totalBytes = 1_000_000;
type Harness = ReturnType<typeof harness>;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
function cloneRecord(record: FilesLargeTextDraftRecord): FilesLargeTextDraftRecord {
  return JSON.parse(JSON.stringify(record)) as FilesLargeTextDraftRecord;
}
function keyFor(overrides: { path?: string; remoteSessionId?: string } = {}): string {
  return filesLargeTextDraftStorageKey({
    workspaceKey: workspace.workspacePath,
    remoteSessionId: overrides.remoteSessionId ?? "",
    path: overrides.path ?? path,
  });
}

class FakeStorage implements FilesLargeTextDraftStorage {
  readonly records = new Map<string, FilesLargeTextDraftRecord>();
  readonly calls: Array<{ kind: "load" | "save" | "delete"; key: string }> = [];
  private readonly holds = new Map<string, Deferred>();
  private readonly failures = new Map<string, unknown>();

  holdNext(kind: "load" | "save" | "delete", key: string): Deferred {
    const gate = deferred();
    this.holds.set(`${kind}:${key}`, gate);
    return gate;
  }
  failNext(kind: "load" | "save" | "delete", key: string, error: unknown): void {
    this.failures.set(`${kind}:${key}`, error);
  }
  async load(key: string): Promise<FilesLargeTextDraftRecord | undefined> {
    this.calls.push({ kind: "load", key });
    this.throwFailure("load", key);
    await this.wait("load", key);
    const record = this.records.get(key);
    return record ? cloneRecord(record) : undefined;
  }
  async save(record: FilesLargeTextDraftRecord): Promise<void> {
    this.calls.push({ kind: "save", key: record.storageKey });
    this.throwFailure("save", record.storageKey);
    await this.wait("save", record.storageKey);
    this.records.set(record.storageKey, cloneRecord(record));
  }
  async delete(key: string): Promise<void> {
    this.calls.push({ kind: "delete", key });
    this.throwFailure("delete", key);
    await this.wait("delete", key);
    this.records.delete(key);
  }
  private throwFailure(kind: string, key: string): void {
    const holdKey = `${kind}:${key}`;
    if (!this.failures.has(holdKey)) return;
    const error = this.failures.get(holdKey);
    this.failures.delete(holdKey);
    throw error;
  }
  private async wait(kind: string, key: string): Promise<void> {
    const holdKey = `${kind}:${key}`;
    const gate = this.holds.get(holdKey);
    if (!gate) return;
    this.holds.delete(holdKey);
    await gate.promise;
  }
}

function harness(options?: {
  probeFile?: (buffer: FilesDraftBuffer) => Promise<FilesLargeTextDraftProbeResult>;
}) {
  const store = createFilesEditorStore();
  const buffer = createLargeTextFileBuffer({ workspace, path, totalBytes });
  store.getState().openBuffer(buffer);
  store.getState().initializeLargeTextEdit(buffer.id, "v1", totalBytes);
  const storage = new FakeStorage();
  let clock = 1;
  const controller = createFilesLargeTextDraftPersistence({
    store,
    storage,
    now: () => clock++,
    ...(options?.probeFile ? { probeFile: options.probeFile } : {}),
  });
  return {
    store,
    storage,
    controller,
    id: buffer.id,
    key: filesLargeTextDraftStorageKey({
      workspaceKey: workspace.workspacePath,
      remoteSessionId: "",
      path,
    }),
  };
}

function coldHarness(
  probeFile: (buffer: FilesDraftBuffer) => Promise<FilesLargeTextDraftProbeResult>,
  kind: "text" | "preview" = "text",
) {
  const store = createFilesEditorStore();
  const buffer =
    kind === "text"
      ? createTextFileBuffer({ workspace, path, text: "small" })
      : createPreviewBuffer({ workspace, path });
  store.getState().openBuffer(buffer);
  const storage = new FakeStorage();
  const record = recordFor(buffer.id);
  storage.records.set(record.storageKey, record);
  const controller = createFilesLargeTextDraftPersistence({ store, storage, probeFile });
  return { store, storage, controller, id: buffer.id, key: record.storageKey };
}

function target(offset: number, originalText: string) {
  return {
    blockIndex: filesLargeTextBlockIndex(offset),
    offset,
    deleteBytes: originalText.length,
    originalText,
  };
}
function editBlock(h: Harness, offset: number, originalText: string, text: string): void {
  h.store.getState().updateLargeTextBlock(h.id, target(offset, originalText), text);
}
function largeBuffer(state: FilesEditorState, id: string): FilesLargeTextBuffer {
  const buffer = state.buffers.find((candidate) => candidate.id === id);
  assert.ok(buffer?.kind === "large-text");
  return buffer;
}
function recordFor(
  bufferId: string,
  overrides: Partial<FilesLargeTextDraftRecord> = {},
): FilesLargeTextDraftRecord {
  const record: FilesLargeTextDraftRecord = {
    schemaVersion: FILES_LARGE_TEXT_DRAFT_SCHEMA_VERSION,
    bufferId,
    path,
    storageKey: "",
    workspaceKey: workspace.workspacePath,
    remoteSessionId: "",
    baseVersion: "v1",
    baseTotalBytes: totalBytes,
    changes: [{ blockIndex: 0, offset: 100, deleteBytes: 1, originalText: "A", text: "B" }],
    updatedAt: 1,
    ...overrides,
  };
  record.storageKey = filesLargeTextDraftStorageKey({
    workspaceKey: record.workspaceKey,
    remoteSessionId: record.remoteSessionId,
    path: record.path,
  });
  return record;
}

test("dirty large 只写有效补丁，undo / 全文不落记录", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  editBlock(h, 0, "AAA", "BBB");
  editBlock(h, 10, "X", "X");
  await h.controller.flush();
  const record = h.storage.records.get(h.key);
  assert.ok(record);
  assert.equal(record.baseVersion, "v1");
  assert.equal(record.changes.length, 1);
  assert.deepEqual(record.changes[0], {
    blockIndex: 0,
    offset: 0,
    deleteBytes: 3,
    originalText: "AAA",
    text: "BBB",
  });
  assert.equal(JSON.stringify(record).includes("undoStack"), false);
  assert.equal(h.controller.getSnapshot().pending[h.id], false);
});

test("旧 write 在途时新的 discard 最终生效，旧结果不会复活记录", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  const gate = h.storage.holdNext("save", h.key);
  editBlock(h, 0, "A", "B");
  editBlock(h, 0, "A", "C");
  h.store.getState().discardLargeTextEdits(h.id);
  gate.resolve();
  await h.controller.flush();
  assert.equal(h.storage.records.has(h.key), false);
  const operations = h.storage.calls
    .filter((call) => call.kind !== "load")
    .map((call) => call.kind);
  assert.deepEqual(operations, ["save", "delete"]);
});

test("同一 baseVersion 恢复补丁；不同版本保留记录并进入 blocked", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id));
  await h.controller.restoreOnActivate(h.id);
  let buffer = largeBuffer(h.store.getState(), h.id);
  assert.equal(buffer.edit?.changes.length, 1);
  assert.equal(buffer.edit?.changes[0]?.text, "B");
  await h.controller.flush();

  h.controller.dispose();
  const stale = harness();
  t.after(() => stale.controller.dispose());
  stale.storage.records.set(stale.key, recordFor(stale.id, { baseVersion: "v0" }));
  await stale.controller.restoreOnActivate(stale.id);
  buffer = largeBuffer(stale.store.getState(), stale.id);
  assert.equal(buffer.edit?.changes.length, 0);
  assert.equal(stale.storage.records.get(stale.key)?.baseVersion, "v0");
  assert.equal(stale.controller.getSnapshot().blocked[stale.id]?.reason, "version-mismatch");

  // blocked 期间用户继续编辑也不能覆盖正在保留的冲突草稿。
  editBlock(stale, 0, "A", "Z");
  await stale.controller.flush();
  assert.equal(stale.storage.records.get(stale.key)?.baseVersion, "v0");

  // 撤销回原文不能把 blocked 记录当成“已放弃”的普通草稿删掉。
  stale.store.getState().undoLargeTextEdit(stale.id);
  await stale.controller.flush();
  assert.equal(stale.storage.records.get(stale.key)?.baseVersion, "v0");
  assert.equal(stale.controller.getSnapshot().blocked[stale.id]?.reason, "version-mismatch");

  // clean 关闭也不会删除未恢复的 blocked 记录。
  stale.store.getState().closeBuffer(stale.id);
  await stale.controller.flush();
  assert.equal(stale.storage.records.get(stale.key)?.baseVersion, "v0");
});

test("运行时补丁优先：异步 load 期间的用户输入不被恢复覆盖", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id));
  const gate = h.storage.holdNext("load", h.key);
  const restore = h.controller.restoreOnActivate(h.id);
  editBlock(h, 0, "A", "local");
  gate.resolve();
  await restore;
  await h.controller.flush();
  const buffer = largeBuffer(h.store.getState(), h.id);
  assert.deepEqual(
    buffer.edit?.changes.map((change) => [change.offset, change.text]),
    [[0, "local"]],
  );
});

test("文件缺失时保留记录、暴露 blocked 并标记 externalChange", async (t) => {
  const h = harness({ probeFile: async () => ({ kind: "missing" }) });
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id));
  await h.controller.restoreOnActivate(h.id);
  const buffer = largeBuffer(h.store.getState(), h.id);
  assert.equal(buffer.edit?.changes.length, 0);
  assert.deepEqual(buffer.externalChange, { kind: "deleted", observedVersion: null });
  assert.equal(h.storage.records.get(h.key)?.baseVersion, "v1");
  assert.equal(h.controller.getSnapshot().blocked[h.id]?.reason, "missing");
});

test("owner A→B→A：旧 load 不落到新 owner，回到 A 后同基准可恢复", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id));
  const gate = h.storage.holdNext("load", h.key);
  const staleRestore = h.controller.restoreOnActivate(h.id);

  h.store.getState().hydrateSession({
    version: 1,
    activeId: h.id,
    openFileIds: [h.id],
    openTabs: [{ id: h.id, kind: "large-text", path: "/tmp/ws/other.txt", workspace }],
    drafts: [],
  });
  h.store.getState().initializeLargeTextEdit(h.id, "v1", totalBytes);
  gate.resolve();
  await staleRestore;
  let buffer = largeBuffer(h.store.getState(), h.id);
  assert.equal(buffer.edit?.changes.length, 0);

  h.store.getState().hydrateSession({
    version: 1,
    activeId: h.id,
    openFileIds: [h.id],
    openTabs: [{ id: h.id, kind: "large-text", path, workspace }],
    drafts: [],
  });
  h.store.getState().initializeLargeTextEdit(h.id, "v1", totalBytes);
  await h.controller.restoreOnActivate(h.id);
  await h.controller.flush();
  buffer = largeBuffer(h.store.getState(), h.id);
  assert.equal(buffer.edit?.changes.length, 1);
  assert.equal(buffer.edit?.changes[0]?.text, "B");
});

test("保存成功、放弃与脏关闭都删除记录", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  editBlock(h, 0, "A", "B");
  await h.controller.flush();
  assert.ok(h.storage.records.has(h.key));

  h.store.getState().markLargeTextSaved(h.id, { version: "v2", totalBytes: totalBytes - 2 });
  await h.controller.flush();
  assert.equal(h.storage.records.has(h.key), false);

  h.store.getState().initializeLargeTextEdit(h.id, "v2", totalBytes - 2);
  editBlock(h, 0, "A", "C");
  await h.controller.flush();
  assert.ok(h.storage.records.has(h.key));
  h.store.getState().discardLargeTextEdits(h.id);
  await h.controller.flush();
  assert.equal(h.storage.records.has(h.key), false);

  editBlock(h, 0, "A", "D");
  await h.controller.flush();
  assert.ok(h.storage.records.has(h.key));
  h.store.getState().closeBuffer(h.id);
  await h.controller.flush();
  assert.equal(h.storage.records.has(h.key), false);
});

test("clean 标签关闭不会删除未恢复的 cold record", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id, { baseVersion: "v0" }));
  h.store.getState().closeBuffer(h.id);
  await h.controller.flush();
  assert.equal(h.storage.records.get(h.key)?.baseVersion, "v0");
});

test("storageKey 隔离远端 owner：load/delete 不会串用 bufferId", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  const remoteKey = keyFor({ remoteSessionId: "remote-1" });
  h.storage.records.set(h.key, recordFor(h.id));
  h.storage.records.set(
    remoteKey,
    recordFor(h.id, { remoteSessionId: "remote-1", baseVersion: "v9" }),
  );
  await h.controller.restoreOnActivate(h.id);
  const buffer = largeBuffer(h.store.getState(), h.id);
  assert.equal(buffer.edit?.changes[0]?.text, "B");
  h.store.getState().closeBuffer(h.id);
  await h.controller.flush();
  assert.equal(h.storage.records.has(h.key), false);
  assert.equal(h.storage.records.get(remoteKey)?.baseVersion, "v9");
});

test("bufferId 迁移：同 key 更新归属，目标冲突时保留双方", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  editBlock(h, 0, "A", "B");
  await h.controller.flush();
  assert.ok(h.storage.records.has(h.key));

  h.store.getState().openBuffer(createLargeTextFileBuffer({ workspace, path, id: "renamed" }));
  assert.equal(await h.controller.migrateBufferId(h.id, "renamed"), true);
  assert.equal(h.storage.records.get(h.key)?.bufferId, "renamed");

  const targetPath = "/tmp/ws/target.txt";
  const targetKey = keyFor({ path: targetPath });
  h.store
    .getState()
    .openBuffer(createLargeTextFileBuffer({ workspace, path: targetPath, id: "target" }));
  h.storage.records.set(targetKey, recordFor("target", { path: targetPath, baseVersion: "v2" }));
  assert.equal(await h.controller.migrateBufferId(h.id, "target"), false);
  assert.equal(h.storage.records.get(h.key)?.baseVersion, "v1");
  assert.equal(h.storage.records.get(targetKey)?.baseVersion, "v2");
  assert.equal(h.controller.getSnapshot().blocked.target?.reason, "rename-target-retained");
});

test("auto rename migration 纳入 flush，转移完成前不会被 beforeunload 丢掉", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  editBlock(h, 0, "A", "B");
  await h.controller.flush();
  const gate = h.storage.holdNext("save", h.key);
  const renamed: FilesLargeTextBuffer = {
    ...largeBuffer(h.store.getState(), h.id),
    id: "renamed",
  };
  h.store.setState({ buffers: [renamed], openIds: ["renamed"], activeId: "renamed" });
  let settled = false;
  const flush = h.controller.flush().then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve();
  await flush;
  assert.equal(settled, true);
  assert.equal(h.storage.records.get(h.key)?.bufferId, "renamed");
});

test("load 失败后不会自动重试；显式 restoreOnActivate 可再次尝试", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id));
  h.storage.failNext("load", h.key, new Error("transient"));
  await h.controller.restoreOnActivate(h.id);
  assert.equal(h.controller.getSnapshot().errors[h.id]?.operation, "load");
  assert.equal(largeBuffer(h.store.getState(), h.id).edit?.changes.length, 0);

  await h.controller.restoreOnActivate(h.id);
  assert.equal(largeBuffer(h.store.getState(), h.id).edit?.changes.length, 1);
});

test("配额失败只暴露 error 快照，不假称已保存；后续编辑仍可写入", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.storage.failNext("save", h.key, new FilesLargeTextDraftStorageError("quota", "full"));
  editBlock(h, 0, "A", "B");
  await h.controller.flush();
  assert.equal(h.storage.records.has(h.key), false);
  assert.equal(h.controller.getSnapshot().errors[h.id]?.kind, "quota");

  editBlock(h, 0, "A", "C");
  await h.controller.flush();
  assert.equal(h.storage.records.get(h.key)?.changes[0]?.text, "C");
  assert.equal(h.controller.getSnapshot().errors[h.id], undefined);
});

test("显式丢弃 blocked 草稿会删除记录并清除提示", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id, { baseVersion: "v0" }));
  await h.controller.restoreOnActivate(h.id);
  assert.ok(h.controller.getSnapshot().blocked[h.id]);
  await h.controller.discardBlockedDraft(h.id);
  assert.equal(h.storage.records.has(h.key), false);
  assert.equal(h.controller.getSnapshot().blocked[h.id], undefined);
});

test("SaveAs 后按旧 owner 删除旧 key，不误删新 owner / 其它 workspace", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  editBlock(h, 0, "A", "B");
  await h.controller.flush();
  const oldOwner = filesLargeTextDraftOwner(largeBuffer(h.store.getState(), h.id));
  const newPath = "/tmp/ws/renamed.txt";
  h.store.getState().markLargeTextSaved(h.id, { path: newPath, version: "v2", totalBytes });
  await h.controller.flush();
  const newKey = keyFor({ path: newPath });
  const remoteKey = keyFor({ remoteSessionId: "remote-1" });
  h.storage.records.set(newKey, recordFor(h.id, { path: newPath, baseVersion: "v2" }));
  h.storage.records.set(
    remoteKey,
    recordFor(h.id, { remoteSessionId: "remote-1", baseVersion: "v7" }),
  );

  assert.equal(await h.controller.discardCommittedDraft(oldOwner), true);
  assert.equal(h.storage.records.has(h.key), false);
  assert.equal(h.storage.records.get(newKey)?.baseVersion, "v2");
  assert.equal(h.storage.records.get(remoteKey)?.baseVersion, "v7");
});

test("旧路径仍被其它缓冲打开时 SaveAs 清理不删除记录", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  editBlock(h, 0, "A", "B");
  await h.controller.flush();
  const oldOwner = filesLargeTextDraftOwner(largeBuffer(h.store.getState(), h.id));
  h.store.getState().markLargeTextSaved(h.id, {
    path: "/tmp/ws/renamed.txt",
    version: "v2",
    totalBytes,
  });
  await h.controller.flush();
  h.store.getState().openBuffer(createLargeTextFileBuffer({ workspace, path, id: "other" }));

  assert.equal(await h.controller.discardCommittedDraft(oldOwner), false);
  assert.ok(h.storage.records.has(h.key));
});

test("SaveAs 旧 key 删除失败保留记录并暴露 delete error", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  editBlock(h, 0, "A", "B");
  await h.controller.flush();
  const oldOwner = filesLargeTextDraftOwner(largeBuffer(h.store.getState(), h.id));
  h.store.getState().markLargeTextSaved(h.id, {
    path: "/tmp/ws/renamed.txt",
    version: "v2",
    totalBytes,
  });
  await h.controller.flush();
  h.storage.failNext("delete", h.key, new Error("disk"));

  assert.equal(await h.controller.discardCommittedDraft(oldOwner), false);
  assert.ok(h.storage.records.has(h.key));
  assert.equal(h.controller.getSnapshot().errors[h.id]?.operation, "delete");
});

test("SaveAs 清理等待旧 key 在途写入，迟到的 save 不会复活记录", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  const gate = h.storage.holdNext("save", h.key);
  editBlock(h, 0, "A", "B");
  const oldOwner = filesLargeTextDraftOwner(largeBuffer(h.store.getState(), h.id));
  h.store.getState().markLargeTextSaved(h.id, {
    path: "/tmp/ws/renamed.txt",
    version: "v2",
    totalBytes,
  });
  const cleanup = h.controller.discardCommittedDraft(oldOwner);
  await new Promise<void>((resolve) => setImmediate(resolve));
  gate.resolve();
  assert.equal(await cleanup, true);
  assert.equal(h.storage.records.has(h.key), false);
});

test("保存锁期间 restore 被静默拒绝，不误报恢复也不删除记录", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id));
  const token = h.store.getState().beginLargeTextSave(h.id);
  assert.ok(token);
  await h.controller.restoreOnActivate(h.id);
  assert.equal(largeBuffer(h.store.getState(), h.id).edit?.changes.length, 0);
  assert.equal(h.controller.getSnapshot().blocked[h.id], undefined);
  assert.equal(h.controller.getSnapshot().errors[h.id], undefined);
  assert.ok(h.storage.records.has(h.key));

  h.store.getState().endLargeTextSave(h.id, token);
  await h.controller.restoreOnActivate(h.id);
  assert.equal(largeBuffer(h.store.getState(), h.id).edit?.changes[0]?.text, "B");
});

test("load 期间开始保存时 restore 放弃套用，保存结束后可再次恢复", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id));
  const gate = h.storage.holdNext("load", h.key);
  const restoring = h.controller.restoreOnActivate(h.id);
  const token = h.store.getState().beginLargeTextSave(h.id);
  assert.ok(token);
  gate.resolve();
  await restoring;
  assert.equal(largeBuffer(h.store.getState(), h.id).edit?.changes.length, 0);
  assert.equal(h.controller.getSnapshot().blocked[h.id], undefined);
  assert.equal(h.controller.getSnapshot().errors[h.id], undefined);
  assert.ok(h.storage.records.has(h.key));

  h.store.getState().endLargeTextSave(h.id, token);
  await h.controller.restoreOnActivate(h.id);
  assert.equal(largeBuffer(h.store.getState(), h.id).edit?.changes[0]?.text, "B");
});

test("显式 force 重试可绕过去重，在版本恢复后真正套用草稿", async (t) => {
  let probe: FilesLargeTextDraftProbeResult = {
    kind: "present",
    version: "v0",
    totalBytes,
  };
  const h = harness({ probeFile: async () => probe });
  t.after(() => h.controller.dispose());
  h.storage.records.set(h.key, recordFor(h.id));
  await h.controller.restoreOnActivate(h.id);
  assert.equal(h.controller.getSnapshot().blocked[h.id]?.reason, "version-mismatch");

  probe = { kind: "present", version: "v1", totalBytes };
  await h.controller.restoreOnActivate(h.id);
  assert.equal(largeBuffer(h.store.getState(), h.id).edit?.changes.length, 0);

  await h.controller.restoreOnActivate(h.id, { force: true });
  assert.equal(largeBuffer(h.store.getState(), h.id).edit?.changes[0]?.text, "B");
  assert.equal(h.controller.getSnapshot().blocked[h.id], undefined);
});

test("cold record 在 text / preview 缓冲仍产生 blocked 并保留记录", async (t) => {
  const cases: Array<{
    kind: "text" | "preview";
    probe: FilesLargeTextDraftProbeResult;
    reason: string;
  }> = [
    { kind: "text", probe: { kind: "missing" }, reason: "missing" },
    { kind: "text", probe: { kind: "binary" }, reason: "binary" },
    {
      kind: "text",
      probe: { kind: "present", version: "v2", totalBytes: 5 },
      reason: "version-mismatch",
    },
    { kind: "preview", probe: { kind: "binary" }, reason: "binary" },
  ];
  for (const item of cases) {
    const h = coldHarness(async () => item.probe, item.kind);
    t.after(() => h.controller.dispose());
    await h.controller.restoreOnActivate(h.id);
    assert.equal(h.controller.getSnapshot().blocked[h.id]?.reason, item.reason);
    assert.equal(h.controller.getSnapshot().blocked[h.id]?.record.path, path);
    assert.equal(h.controller.getSnapshot().errors[h.id], undefined);
    assert.ok(h.storage.records.has(h.key));
  }
});
