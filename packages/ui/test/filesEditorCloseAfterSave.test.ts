import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFilesCloseAfterDiscard,
  resolveFilesCloseAfterSave,
} from "../src/files-workbench/filesEditorCloseAfterSave.js";
import {
  createLargeTextFileBuffer,
  createTextFileBuffer,
} from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/work" };

test("保存成功但 await 期间又有新输入时关闭流程重新提示，不静默关闭脏缓冲", () => {
  const path = "/work/close-new-input.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "one" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path, text: "one", workspace, version: "v1" });
  store.getState().updateText(id, "two");

  // 模拟保存成功：保存期间捕获的正文已落盘，但用户随后输入了 "three"。
  store.getState().markSaved(id, {
    path,
    text: "two",
    workspace,
    preserveCurrentText: true,
    version: "v2",
  });
  store.getState().updateText(id, "three");

  assert.equal(resolveFilesCloseAfterSave(store.getState().buffers, id), "prompt");
});

test("保存后缓冲干净才允许直接关闭；已关闭的缓冲返回 gone", () => {
  const path = "/work/close-clean.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "one" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path, text: "one", workspace, version: "v1" });

  assert.equal(resolveFilesCloseAfterSave(store.getState().buffers, id), "close");
  store.getState().closeBuffer(id);
  assert.equal(resolveFilesCloseAfterSave(store.getState().buffers, id), "gone");
});

test("discard await 后同路径 buffer 被关闭重开时不误关新 owner", () => {
  const path = "/work/close-reopen.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "old" }));
  const oldBuffer = store.getState().buffers[0]!;
  assert.ok(oldBuffer.kind === "text");
  const snapshot = {
    bufferRef: oldBuffer,
    id: oldBuffer.id,
    kind: oldBuffer.kind,
    path: oldBuffer.path,
    workspaceKey: "/work",
    text: oldBuffer.text,
    savedText: oldBuffer.savedText,
    diskVersion: oldBuffer.diskVersion,
  };
  store.getState().closeBuffer(oldBuffer.id);
  store.getState().openBuffer({ ...oldBuffer, text: "new owner" });
  assert.equal(resolveFilesCloseAfterDiscard(store.getState().buffers, snapshot), "prompt");
  assert.equal(store.getState().buffers[0]?.kind, "text");
});

test("discard 异步等待期间文本新输入或身份变化时拒绝关闭", () => {
  const path = "/work/close-discard-text.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "one" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path, text: "one", workspace, version: "v1" });
  store.getState().updateText(id, "draft");
  const original = store.getState().buffers[0]!;
  assert.ok(original.kind === "text");
  const snapshot = {
    bufferRef: original,
    id,
    kind: original.kind,
    path: original.path,
    workspaceKey: "/work",
    text: original.text,
    savedText: original.savedText,
    diskVersion: original.diskVersion,
  };

  store.getState().updateText(id, "typed while storage clears");
  assert.equal(resolveFilesCloseAfterDiscard(store.getState().buffers, snapshot), "prompt");

  store.getState().applyFileMutation({
    kind: "rename",
    workspace,
    sourcePath: path,
    targetPath: "/work/renamed.txt",
  });
  assert.equal(resolveFilesCloseAfterDiscard(store.getState().buffers, snapshot), "prompt");
});

test("discard 异步等待期间大文件进入保存或产生新 edit 时拒绝关闭", () => {
  const path = "/work/close-discard-large.log";
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path, totalBytes: 10 });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", 10);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "b",
    );
  const original = store.getState().buffers[0]!;
  assert.ok(original.kind === "large-text");
  const snapshot = {
    bufferRef: original,
    id: large.id,
    kind: original.kind,
    path: original.path,
    workspaceKey: "/work",
    revision: original.edit?.revision,
    baseVersion: original.edit?.baseVersion,
    baseTotalBytes: original.edit?.baseTotalBytes,
  };

  const token = store.getState().beginLargeTextSave(large.id);
  assert.ok(token);
  assert.equal(resolveFilesCloseAfterDiscard(store.getState().buffers, snapshot), "prompt");
  store.getState().endLargeTextSave(large.id, token);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "c",
    );
  assert.equal(resolveFilesCloseAfterDiscard(store.getState().buffers, snapshot), "prompt");
});

test("discard snapshot 命中原缓冲时允许继续关闭", () => {
  const path = "/work/close-discard-same.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "draft" }));
  const buffer = store.getState().buffers[0]!;
  assert.ok(buffer.kind === "text");
  const snapshot = {
    bufferRef: buffer,
    id: buffer.id,
    kind: buffer.kind,
    path: buffer.path,
    workspaceKey: "/work",
    text: buffer.text,
    savedText: buffer.savedText,
    diskVersion: buffer.diskVersion,
  };
  assert.equal(resolveFilesCloseAfterDiscard(store.getState().buffers, snapshot), "close");
});

test("大文件保存期间又有块编辑时关闭流程重新提示，撤销到干净后允许关闭", () => {
  const path = "/work/close-large.log";
  const store = createFilesEditorStore();
  const large = createLargeTextFileBuffer({ workspace, path, totalBytes: 10 });
  store.getState().openBuffer(large);
  store.getState().initializeLargeTextEdit(large.id, "v1", 10);
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "b",
    );
  store.getState().markLargeTextSaved(large.id, { path, version: "v2", totalBytes: 10 });
  store
    .getState()
    .updateLargeTextBlock(
      large.id,
      { blockIndex: 0, offset: 0, deleteBytes: 1, originalText: "a" },
      "c",
    );

  assert.equal(resolveFilesCloseAfterSave(store.getState().buffers, large.id), "prompt");

  store.getState().discardLargeTextEdits(large.id);
  assert.equal(resolveFilesCloseAfterSave(store.getState().buffers, large.id), "close");
});
