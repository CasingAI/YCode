import assert from "node:assert/strict";
import test from "node:test";
import {
  FilesLargeTextDraftStorageError,
  FILES_LARGE_TEXT_DRAFT_SCHEMA_VERSION,
  createFilesLargeTextDraftRecord,
  createIndexedDbFilesLargeTextDraftStorage,
  filesLargeTextDraftBufferIdentity,
  normalizeFilesLargeTextDraftRecord,
} from "../src/files-workbench/filesLargeTextDraftStorage.js";
import type {
  FilesLargeTextBuffer,
  FilesLargeTextEditState,
} from "../src/files-workbench/filesEditorTypes.js";

const workspace = { workspacePath: "/tmp/large" };

function buffer(): FilesLargeTextBuffer {
  return {
    id: "file:/tmp/large:/tmp/large/big.txt",
    kind: "large-text",
    path: "/tmp/large/big.txt",
    title: "big.txt",
    workspace,
  };
}

function edit(): FilesLargeTextEditState {
  return {
    baseVersion: "v1",
    baseTotalBytes: 300,
    changes: [
      { blockIndex: 0, offset: 0, deleteBytes: 3, originalText: "AAA", text: "BBB" },
      { blockIndex: 0, offset: 10, deleteBytes: 1, originalText: "X", text: "X" },
    ],
    undoStack: [
      {
        blockIndex: 0,
        offset: 0,
        deleteBytes: 3,
        originalText: "AAA",
        after: "BBB",
      },
    ],
    redoStack: [],
    revision: 3,
  };
}

test("记录只包含有效补丁与身份字段，不保存 undo、全文或未修改块", () => {
  const record = createFilesLargeTextDraftRecord(buffer(), edit(), 123);
  assert.ok(record);
  assert.equal(record.schemaVersion, FILES_LARGE_TEXT_DRAFT_SCHEMA_VERSION);
  assert.equal(record.bufferId, buffer().id);
  assert.equal(record.path, "/tmp/large/big.txt");
  assert.equal(record.workspaceKey, "/tmp/large");
  assert.equal(record.remoteSessionId, "");
  assert.equal(record.storageKey, filesLargeTextDraftBufferIdentity(buffer()));
  assert.equal(record.storageKey, ["/tmp/large", "", "/tmp/large/big.txt"].join("\u0000"));
  assert.equal(record.baseVersion, "v1");
  assert.equal(record.baseTotalBytes, 300);
  assert.equal(record.updatedAt, 123);
  assert.deepEqual(record.changes, [
    { blockIndex: 0, offset: 0, deleteBytes: 3, originalText: "AAA", text: "BBB" },
  ]);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("undoStack"), false);
  assert.equal(serialized.includes("redoStack"), false);
  assert.equal(serialized.includes("savedText"), false);
});

test("记录外壳校验拒绝未知 schema 与缺失 identity", () => {
  const record = createFilesLargeTextDraftRecord(buffer(), edit(), 123);
  assert.ok(record);
  assert.ok(normalizeFilesLargeTextDraftRecord(record));
  assert.equal(normalizeFilesLargeTextDraftRecord({ ...record, schemaVersion: 99 }), undefined);
  assert.equal(normalizeFilesLargeTextDraftRecord({ ...record, workspaceKey: "" }), undefined);
  assert.equal(normalizeFilesLargeTextDraftRecord({ ...record, storageKey: "other" }), undefined);
  assert.equal(normalizeFilesLargeTextDraftRecord({ ...record, changes: [{}] }), undefined);
});

test("storageKey 包含 workspace identity、remoteSession 与 path，避免 bufferId 碰撞", () => {
  const local = buffer();
  const remote = {
    ...buffer(),
    workspace: { workspacePath: "/tmp/large", workspaceRemoteSessionId: "r1" },
  };
  const otherPath = { ...buffer(), path: "/tmp/large/other.txt" };
  const keys = [local, remote, otherPath].map(filesLargeTextDraftBufferIdentity);
  assert.equal(new Set(keys).size, 3);
  assert.equal(
    createFilesLargeTextDraftRecord(remote, edit(), 1)?.storageKey,
    filesLargeTextDraftBufferIdentity(remote),
  );
});

test("无 IndexedDB 时 adapter 返回 unavailable 而不是崩溃", async () => {
  const storage = createIndexedDbFilesLargeTextDraftStorage({ factory: null });
  for (const operation of [
    () => storage.load("x"),
    () =>
      storage.save(
        normalizeFilesLargeTextDraftRecord(createFilesLargeTextDraftRecord(buffer(), edit(), 1))!,
      ),
    () => storage.delete("x"),
  ]) {
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof FilesLargeTextDraftStorageError);
      assert.equal(error.kind, "unavailable");
      return true;
    });
  }
});
