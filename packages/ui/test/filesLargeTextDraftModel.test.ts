import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_LARGE_TEXT_BLOCK_STEP,
  canSaveFilesBuffer,
  createLargeTextFileBuffer,
  createRestoredTextFileBuffer,
  filesLargeTextEditPatches,
  isFilesBufferDirty,
} from "../src/files-workbench/filesEditorModel.js";
import { filesLargeTextBlockIndex } from "../src/files-workbench/filesLargeTextBlockModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type {
  FilesLargeTextBlockChange,
  FilesLargeTextBlockTarget,
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/tmp/large" };
const totalBytes = FILES_LARGE_TEXT_BLOCK_STEP * 2 + 100;

function target(
  offset: number,
  originalText: string,
  deleteBytes = originalText.length,
  extra?: Partial<FilesLargeTextBlockTarget>,
): FilesLargeTextBlockTarget {
  return {
    blockIndex: filesLargeTextBlockIndex(offset),
    offset,
    deleteBytes,
    originalText,
    ...extra,
  };
}

function openLargeBuffer() {
  const store = createFilesEditorStore();
  const buffer = createLargeTextFileBuffer({
    workspace,
    path: "/tmp/large/big.txt",
    totalBytes,
    readonlyReason: "encoding",
  });
  store.getState().openBuffer(buffer);
  return { store, id: buffer.id };
}

test("大文件块编辑：初始化幂等、脏态、canSave 与补丁按坐标排序", () => {
  const { store, id } = openLargeBuffer();
  const uninitialized = store.getState().buffers.find((buffer) => buffer.id === id);
  assert.ok(uninitialized?.kind === "large-text");
  assert.equal(uninitialized.edit, undefined);
  assert.equal(canSaveFilesBuffer(uninitialized), false);

  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  const initial = store.getState().buffers.find((buffer) => buffer.id === id);
  assert.ok(initial?.kind === "large-text");
  assert.equal(initial.edit?.baseVersion, "v1");
  assert.equal(initial.edit?.baseTotalBytes, totalBytes);
  assert.equal(isFilesBufferDirty(initial), false);
  // 干净大文件也必须能另存为；同路径干净保存由保存流程 no-op。
  assert.equal(canSaveFilesBuffer(initial), true);

  const sameEdit = initial.edit;
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  const unchanged = store.getState().buffers.find((buffer) => buffer.id === id);
  assert.ok(unchanged?.kind === "large-text");
  assert.equal(unchanged.edit, sameEdit);

  store.getState().updateLargeTextBlock(id, target(0, "AAA"), "BBBB");
  store.getState().updateLargeTextBlock(id, target(FILES_LARGE_TEXT_BLOCK_STEP, "CCC"), "D");
  const buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(isFilesBufferDirty(buffer), true);
  assert.equal(canSaveFilesBuffer(buffer), true);
  assert.deepEqual(filesLargeTextEditPatches(buffer), [
    { offset: 0, deleteBytes: 3, text: "BBBB" },
    { offset: FILES_LARGE_TEXT_BLOCK_STEP, deleteBytes: 3, text: "D" },
  ]);
});

test("同一块连续编辑只保留一条修改，历史按次记录；回到原文即清除脏态", () => {
  const { store, id } = openLargeBuffer();
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  store.getState().updateLargeTextBlock(id, target(10, "hello"), "hey");
  store.getState().updateLargeTextBlock(id, target(10, "hello"), "hi");
  let buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.edit?.changes.length, 1);
  assert.equal(buffer.edit?.changes[0]?.text, "hi");
  assert.equal(buffer.edit?.undoStack.length, 2);
  assert.equal(buffer.edit?.redoStack.length, 0);

  store.getState().updateLargeTextBlock(id, target(10, "hello"), "hello");
  buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.edit?.changes.length, 0);
  assert.equal(isFilesBufferDirty(buffer), false);
  assert.equal(canSaveFilesBuffer(buffer), true);
});

test("全 buffer 撤销 / 重做跨块按编辑顺序回放，新编辑清空重做栈", () => {
  const { store, id } = openLargeBuffer();
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  store.getState().updateLargeTextBlock(id, target(0, "A"), "A1");
  store.getState().updateLargeTextBlock(id, target(FILES_LARGE_TEXT_BLOCK_STEP, "B"), "B1");

  const changes = (): FilesLargeTextBlockChange[] => {
    const buffer = store.getState().buffers.find((item) => item.id === id);
    assert.ok(buffer?.kind === "large-text");
    return buffer.edit?.changes ?? [];
  };

  store.getState().undoLargeTextEdit(id);
  assert.deepEqual(
    changes().map((change) => [change.offset, change.text]),
    [[0, "A1"]],
  );
  store.getState().undoLargeTextEdit(id);
  assert.equal(changes().length, 0);
  store.getState().undoLargeTextEdit(id);
  assert.equal(changes().length, 0);

  store.getState().redoLargeTextEdit(id);
  assert.deepEqual(
    changes().map((change) => [change.offset, change.text]),
    [[0, "A1"]],
  );
  store.getState().redoLargeTextEdit(id);
  assert.equal(changes().length, 2);

  store.getState().undoLargeTextEdit(id);
  store.getState().updateLargeTextBlock(id, target(2, "P"), "Q");
  let buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.edit?.redoStack.length, 0);
  assert.deepEqual(
    changes().map((change) => [change.offset, change.text]),
    [
      [0, "A1"],
      [2, "Q"],
    ],
  );
});

test("非法块、越界坐标和不匹配 blockIndex 一律拒绝写入", () => {
  const { store, id } = openLargeBuffer();
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  const before = store.getState().buffers.find((item) => item.id === id);

  store.getState().updateLargeTextBlock(id, target(0, "A", 1, { hasDecodingErrors: true }), "B");
  assert.equal(
    store.getState().buffers.find((item) => item.id === id),
    before,
  );

  store.getState().updateLargeTextBlock(id, target(0, "A", totalBytes + 1), "B");
  assert.equal(
    store.getState().buffers.find((item) => item.id === id),
    before,
  );

  store.getState().updateLargeTextBlock(id, { ...target(0, "A"), blockIndex: 5 }, "B");
  assert.equal(
    store.getState().buffers.find((item) => item.id === id),
    before,
  );
});

test("EOF 空追加使用原文件末尾坐标，并作为普通补丁参与保存", () => {
  const { store, id } = openLargeBuffer();
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  const append = target(totalBytes, "", 0);
  assert.equal(append.blockIndex, filesLargeTextBlockIndex(totalBytes));
  store.getState().updateLargeTextBlock(id, append, "tail");
  const buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(isFilesBufferDirty(buffer), true);
  assert.deepEqual(filesLargeTextEditPatches(buffer), [
    { offset: totalBytes, deleteBytes: 0, text: "tail" },
  ]);
});

test("readonlyReason 为 encoding 时仍允许保存局部合法块修改", () => {
  const { store, id } = openLargeBuffer();
  const buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.readonlyReason, "encoding");

  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  store.getState().updateLargeTextBlock(id, target(0, "ok"), "edited");
  const next = store.getState().buffers.find((item) => item.id === id);
  assert.ok(next?.kind === "large-text");
  assert.equal(next.readonlyReason, "encoding");
  assert.equal(canSaveFilesBuffer(next), true);
});

test("外部变化只记录提示，不改变草稿与基准；丢弃只清草稿", () => {
  const { store, id } = openLargeBuffer();
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  store.getState().updateLargeTextBlock(id, target(0, "A"), "B");
  store.getState().setLargeTextExternalChange(id, {
    kind: "changed",
    observedVersion: "v2",
  });

  let buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.deepEqual(buffer.externalChange, { kind: "changed", observedVersion: "v2" });
  assert.equal(buffer.edit?.baseVersion, "v1");
  assert.equal(buffer.edit?.changes.length, 1);
  assert.equal(isFilesBufferDirty(buffer), true);

  // 相同提示不产生新状态。
  const same = buffer;
  store.getState().setLargeTextExternalChange(id, {
    kind: "changed",
    observedVersion: "v2",
  });
  assert.equal(
    store.getState().buffers.find((item) => item.id === id),
    same,
  );

  // 脏草稿遇到不同基准初始化时不得 rebase。
  store.getState().initializeLargeTextEdit(id, "v2", totalBytes + 50);
  buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.edit?.baseVersion, "v1");
  assert.equal(buffer.edit?.baseTotalBytes, totalBytes);

  store.getState().discardLargeTextEdits(id);
  buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.edit?.baseVersion, "v1");
  assert.equal(buffer.edit?.changes.length, 0);
  assert.equal(buffer.externalChange, undefined);
  assert.equal(isFilesBufferDirty(buffer), false);
});

test("保存成功重建基准、迁移路径并清空历史；缓冲 ID 保持稳定", () => {
  const { store, id } = openLargeBuffer();
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  store.getState().updateLargeTextBlock(id, target(0, "A"), "B");
  store.getState().markLargeTextSaved(id, {
    path: "/tmp/large/renamed.txt",
    version: "v2",
    totalBytes: totalBytes + 7,
  });

  const buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.id, id);
  assert.equal(buffer.path, "/tmp/large/renamed.txt");
  assert.equal(buffer.title, "renamed.txt");
  assert.equal(buffer.edit?.baseVersion, "v2");
  assert.equal(buffer.edit?.baseTotalBytes, totalBytes + 7);
  assert.equal(buffer.edit?.changes.length, 0);
  assert.equal(buffer.edit?.undoStack.length, 0);
  assert.equal(buffer.externalChange, undefined);
  assert.equal(canSaveFilesBuffer(buffer), true);
});

test("保存期间基准初始化被拒绝，提交结束后才能重新建立基准", () => {
  const { store, id } = openLargeBuffer();
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  const token = store.getState().beginLargeTextSave(id);
  assert.ok(token);

  store.getState().initializeLargeTextEdit(id, "v2", totalBytes + 5);
  let buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.edit?.baseVersion, "v1");

  store.getState().endLargeTextSave(id, token);
  store.getState().initializeLargeTextEdit(id, "v2", totalBytes + 5);
  buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.edit?.baseVersion, "v2");
});

test("IndexedDB 草稿恢复：基准一致才套用，非法补丁被清洗", () => {
  const { store, id } = openLargeBuffer();
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);

  // 草稿基准与当前磁盘基准不一致时拒绝恢复，绝不做隐式 rebase。
  const rejected = store.getState().restoreLargeTextEdit(id, {
    baseVersion: "v2",
    baseTotalBytes: totalBytes,
    changes: [],
  });
  assert.equal(rejected, false);
  let buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.equal(buffer.edit?.baseVersion, "v1");

  const applied = store.getState().restoreLargeTextEdit(id, {
    baseVersion: "v1",
    baseTotalBytes: totalBytes,
    changes: [
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "A", text: "B" },
      { blockIndex: 2, offset: 0, deleteBytes: 1, originalText: "A", text: "B" },
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "A", text: "A" },
    ],
  });
  assert.equal(applied, true);
  buffer = store.getState().buffers.find((item) => item.id === id);
  assert.ok(buffer?.kind === "large-text");
  assert.deepEqual(buffer.edit?.changes, [
    { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "A", text: "B" },
  ]);
  assert.equal(isFilesBufferDirty(buffer), true);

  // 不同基准不再覆盖已有草稿。
  const before = buffer;
  const stale = store.getState().restoreLargeTextEdit(id, {
    baseVersion: "v3",
    baseTotalBytes: totalBytes,
    changes: [],
  });
  assert.equal(stale, false);
  assert.equal(
    store.getState().buffers.find((item) => item.id === id),
    before,
  );
});

test("snapshotSession 不包含大文件 edit，只保留标签元数据", () => {
  const { store, id } = openLargeBuffer();
  store.getState().initializeLargeTextEdit(id, "v1", totalBytes);
  store.getState().updateLargeTextBlock(id, target(0, "A"), "B");
  const session = store.getState().snapshotSession();
  assert.equal(session.drafts.length, 0);
  assert.equal(
    session.openTabs.some((tab) => tab.id === id && tab.kind === "large-text"),
    true,
  );
  const serialized = JSON.stringify(session);
  assert.equal(serialized.includes('"edit"'), false);
  assert.equal(serialized.includes('"changes"'), false);
  assert.equal(serialized.includes('"undoStack"'), false);
});

test("普通文本接受 diskVersion / externalChange，清空提示不影响 isDirty", () => {
  const store = createFilesEditorStore();
  const buffer = createRestoredTextFileBuffer({
    id: "restored-1",
    workspace,
    path: "/tmp/large/notes.txt",
  });
  store.getState().openBuffer(buffer);
  store.getState().setTextLoadState(buffer.id, "loading");
  store.getState().restoreTextContent(buffer.id, { text: "hello", version: "v1" });

  let text = store.getState().buffers.find((item) => item.id === buffer.id);
  assert.ok(text?.kind === "text");
  assert.equal(text.diskVersion, "v1");
  assert.equal(text.text, "hello");
  assert.equal(text.savedText, "hello");
  assert.equal(isFilesBufferDirty(text), false);

  store.getState().setTextExternalChange(buffer.id, {
    kind: "deleted",
    observedVersion: null,
  });
  text = store.getState().buffers.find((item) => item.id === buffer.id);
  assert.ok(text?.kind === "text");
  assert.deepEqual(text.externalChange, { kind: "deleted", observedVersion: null });
  assert.equal(isFilesBufferDirty(text), false);

  store.getState().updateText(buffer.id, "changed");
  text = store.getState().buffers.find((item) => item.id === buffer.id);
  assert.ok(text?.kind === "text");
  assert.equal(text.diskVersion, "v1");
  assert.equal(text.externalChange?.kind, "deleted");
  assert.equal(isFilesBufferDirty(text), true);

  store.getState().markSaved(buffer.id, {
    path: buffer.path!,
    text: "changed",
    workspace,
    version: "v2",
  });
  text = store
    .getState()
    .buffers.find((item) => item.kind === "text" && item.path === "/tmp/large/notes.txt");
  assert.ok(text?.kind === "text");
  assert.equal(text.id, `file:/tmp/large:/tmp/large/notes.txt`);
  assert.equal(text.diskVersion, "v2");
  assert.equal(text.externalChange, undefined);
  assert.equal(isFilesBufferDirty(text), false);
});
