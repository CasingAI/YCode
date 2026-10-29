import assert from "node:assert/strict";
import test from "node:test";
import type { FileTextWindow } from "@zcode/shared";
import { reloadFilesBufferFromDisk } from "../src/files-workbench/filesEditorDiskReload.js";
import {
  createLargeTextFileBuffer,
  createTextFileBuffer,
} from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type { FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/work" };

function windowOf(
  path: string,
  content: string,
  version: string,
  options?: { totalBytes?: number; hasDecodingErrors?: boolean },
): FileTextWindow {
  const totalBytes = options?.totalBytes ?? Buffer.byteLength(content);
  return {
    path,
    content,
    offset: 0,
    bytesRead: Buffer.byteLength(content),
    nextOffset: totalBytes,
    totalBytes,
    version,
    isBinary: false,
    eof: true,
    truncated: false,
    ...(options?.hasDecodingErrors === undefined
      ? undefined
      : { hasDecodingErrors: options.hasDecodingErrors }),
  };
}

function pendingReader() {
  let resolve!: (window: FileTextWindow) => void;
  return {
    resolve: (window: FileTextWindow) => resolve(window),
    readTextFileWindow: () =>
      new Promise<FileTextWindow>((next) => {
        resolve = next;
      }),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("显式重载期间出现新输入时不提交磁盘内容，保留用户新草稿", async () => {
  const path = "/work/reload-text.txt";
  const store = createFilesEditorStore();
  store.getState().openBuffer(createTextFileBuffer({ workspace, path, text: "local" }));
  const id = store.getState().buffers[0]!.id;
  store.getState().markSaved(id, { path, text: "disk", workspace, version: "v1" });
  store.getState().updateText(id, "local");

  const reader = pendingReader();
  const reloading = reloadFilesBufferFromDisk({
    store,
    bufferId: id,
    allowDirty: true,
    fileService: reader,
    isCurrentRequest: () => true,
    persist: () => undefined,
  });
  await settle();
  store.getState().updateText(id, "typed-during-reload");
  reader.resolve(windowOf(path, "disk", "v2"));

  assert.equal(await reloading, false);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "text");
  assert.equal(current.text, "typed-during-reload");
  assert.equal(current.diskVersion, "v1");
});

test("显式重载大文件读取成功后丢弃旧块草稿并建立新基准", async () => {
  const path = "/work/reload-large.log";
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

  const reader = pendingReader();
  const reloading = reloadFilesBufferFromDisk({
    store,
    bufferId: large.id,
    allowDirty: true,
    fileService: reader,
    isCurrentRequest: () => true,
    persist: () => undefined,
  });
  await settle();
  reader.resolve(windowOf(path, "a", "v2", { hasDecodingErrors: true }));

  assert.equal(await reloading, true);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "large-text");
  assert.equal(current.edit?.baseVersion, "v2");
  assert.deepEqual(current.edit?.changes, []);
});

test("大文件保存期间重载不会丢弃正在提交的草稿", async () => {
  const path = "/work/reload-during-save.log";
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

  const reader = pendingReader();
  const reloading = reloadFilesBufferFromDisk({
    store,
    bufferId: large.id,
    allowDirty: true,
    fileService: reader,
    isCurrentRequest: () => true,
    persist: () => undefined,
  });
  await settle();
  const token = store.getState().beginLargeTextSave(large.id);
  assert.ok(token);
  reader.resolve(windowOf(path, "a", "v2", { hasDecodingErrors: true }));

  assert.equal(await reloading, false);
  const current = store.getState().buffers[0]!;
  assert.ok(current.kind === "large-text");
  assert.equal(current.edit?.baseVersion, "v1");
  assert.equal(current.edit?.changes[0]?.text, "b");
  store.getState().endLargeTextSave(large.id, token);
});
