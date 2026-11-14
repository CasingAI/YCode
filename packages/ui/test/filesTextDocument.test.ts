import assert from "node:assert/strict";
import test from "node:test";
import {
  FILES_TEXT_FIRST_LINE_MAX_CHARS,
  captureFilesTextSnapshot,
  filesTextBufferFirstLine,
  filesTextBufferIsEmpty,
  snapshotFilesTextBuffer,
} from "../src/files-workbench/filesTextDocumentModel.js";
import {
  createTextFileBuffer,
  isFilesBufferDirty,
} from "../src/files-workbench/filesEditorModel.js";
import { persistableDrafts } from "../src/files-workbench/filesEditorPersistableModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type {
  FilesTextBuffer,
  FilesTextDocumentBinding,
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";
import { saveFilesTextBuffer } from "../src/files-workbench/filesEditorSaveIO.js";
import { reloadFilesBufferFromDisk } from "../src/files-workbench/filesEditorDiskReload.js";
import type { CommitTextFileParams, CommitTextFileResult, FileTextWindow } from "@zcode/shared";

const workspace: FilesWorkspaceRef = { workspacePath: "/work" };

function diskWindow(content: string, version = "v2"): FileTextWindow {
  return {
    path: "/work/a.ts",
    content,
    offset: 0,
    bytesRead: content.length,
    nextOffset: content.length,
    totalBytes: content.length,
    version,
    isBinary: false,
    eof: true,
    truncated: false,
  };
}

interface FakeDocument extends FilesTextDocumentBinding {
  type(text: string): void;
  undoTo(versionId: number): void;
  markDisposed(): void;
  stats(): { reads: number; replacements: number };
}

/**
 * 运行时正文文档替身：每次变更推进替代版本号，读取全文单独计数，
 * 用来证明局部输入路径不读取全文。
 */
function createFakeDocument(initial: string): FakeDocument {
  let text = initial;
  let versionId = 1;
  let reads = 0;
  let replacements = 0;
  const disposed = { value: false };
  return {
    getText: () => {
      reads += 1;
      return text;
    },
    getVersionId: () => versionId,
    replaceText: (next) => {
      replacements += 1;
      text = next;
      versionId += 1;
    },
    getFirstLine: (maxLength = FILES_TEXT_FIRST_LINE_MAX_CHARS) => {
      const end = text.search(/[\r\n]/);
      const line = end < 0 ? text : text.slice(0, end);
      return line.slice(0, maxLength);
    },
    getLength: () => text.length,
    isDisposed: () => disposed.value,
    type: (next) => {
      text += next;
      versionId += 1;
    },
    undoTo: (target) => {
      versionId = target;
    },
    markDisposed: () => {
      disposed.value = true;
    },
    stats: () => ({ reads, replacements }),
  };
}

function openTextBuffer(store: ReturnType<typeof createFilesEditorStore>): FilesTextBuffer {
  const buffer = createTextFileBuffer({ workspace, path: "/work/a.ts", text: "hello" });
  store.getState().openBuffer(buffer);
  return buffer;
}

test("local input marks dirty without reading full text and undo restores clean state", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);

  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), false);

  document.type("!");
  store.getState().noteTextDocumentChange(buffer.id);
  const dirty = store.getState().buffers[0]!;
  assert.equal(isFilesBufferDirty(dirty), true);
  assert.equal(dirty.kind === "text" ? dirty.documentRevision : undefined, 1);
  assert.equal(store.getState().textChangeEpoch, 1);
  assert.deepEqual(document.stats(), { reads: 0, replacements: 0 });

  document.undoTo(1);
  store.getState().noteTextDocumentChange(buffer.id);
  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), false);
  assert.deepEqual(document.stats(), { reads: 0, replacements: 0 });
});

test("a dirty draft attached to the model has no clean baseline", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  store.getState().updateText(buffer.id, "local draft");
  const document = createFakeDocument("local draft");
  store.getState().attachTextDocument(buffer.id, document);

  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), true);
  document.undoTo(document.getVersionId());
  store.getState().noteTextDocumentChange(buffer.id);
  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), true);
});

test("reattaching a clean buffer after the old model was disposed stays clean", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const previous = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, previous);
  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), false);

  // 编辑器/模型被回收但 Store 还未来得及 detach：重挂载不能把干净缓冲误判为脏。
  previous.markDisposed();
  const replacement = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, replacement);

  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), false);
  replacement.type("!");
  store.getState().noteTextDocumentChange(buffer.id);
  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), true);
});

test("split views sharing one model keep the document bound until the last view detaches", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  // 分屏两个视图绑定同一个 Monaco model：provider 会返回同一个绑定对象。
  store.getState().attachTextDocument(buffer.id, document);
  store.getState().attachTextDocument(buffer.id, document);

  document.type("!");
  // 同一 model 的两个内容监听器各触发一次，但一次编辑只推进一次 revision/epoch。
  store.getState().noteTextDocumentChange(buffer.id);
  store.getState().noteTextDocumentChange(buffer.id);
  const edited = store.getState().buffers[0]!;
  assert.equal(edited.kind === "text" ? edited.documentRevision : undefined, 1);
  assert.equal(store.getState().textChangeEpoch, 1);
  assert.equal(isFilesBufferDirty(edited), true);

  // 关闭 B：仍有视图持有该 model，不能固化/解绑正文。
  store.getState().detachTextDocument(buffer.id, document);
  const stillBound = store.getState().buffers[0]!;
  assert.equal(stillBound.kind === "text" ? stillBound.document : undefined, document);

  document.type("?");
  store.getState().noteTextDocumentChange(buffer.id);
  const afterSecondEdit = store.getState().buffers[0]!;
  assert.equal(snapshotFilesTextBuffer(afterSecondEdit), "hello!?");
  assert.equal(isFilesBufferDirty(afterSecondEdit), true);
  assert.equal(store.getState().textChangeEpoch, 2);

  // 关闭 A（最后一个视图）才固化快照并解绑。
  store.getState().detachTextDocument(buffer.id, document);
  const unbound = store.getState().buffers[0]!;
  assert.equal(unbound.kind === "text" ? unbound.document : undefined, undefined);
  assert.equal(unbound.kind === "text" ? unbound.text : undefined, "hello!?");
  assert.equal(isFilesBufferDirty(unbound), true);
});

test("reattaching the same model preserves the saved baseline across an editor rebuild", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);

  document.type("!");
  store.getState().noteTextDocumentChange(buffer.id);
  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), true);

  // 主题切换 / 拖组会卸载再挂载同一个 model：基线必须按版本域保留。
  store.getState().detachTextDocument(buffer.id, document);
  store.getState().attachTextDocument(buffer.id, document);
  const rebuilt = store.getState().buffers[0]!;
  assert.equal(isFilesBufferDirty(rebuilt), true);

  document.undoTo(1);
  store.getState().noteTextDocumentChange(buffer.id);
  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), false);
});

test("a replacement model never inherits the old baseline and stays dirty", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const previous = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, previous);
  previous.type("!");
  store.getState().noteTextDocumentChange(buffer.id);
  store.getState().detachTextDocument(buffer.id, previous);
  previous.markDisposed();

  // 旧 model 已回收，新 model 的替代版本号即使同样是 2 也不是同一个版本域。
  const replacement = createFakeDocument("hello!");
  store.getState().attachTextDocument(buffer.id, replacement);
  const attached = store.getState().buffers[0]!;
  assert.equal(isFilesBufferDirty(attached), true);

  replacement.undoTo(1);
  store.getState().noteTextDocumentChange(buffer.id);
  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), true);
});

test("snapshots read the bound document once while local input stays stale in buffer text", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);

  document.type(" world");
  store.getState().noteTextDocumentChange(buffer.id);
  const current = store.getState().buffers[0]!;
  assert.equal(current.kind === "text" ? current.text : undefined, "hello");

  assert.equal(snapshotFilesTextBuffer(current), "hello world");
  const snapshot = captureFilesTextSnapshot(current);
  assert.deepEqual(snapshot, { text: "hello world", documentVersionId: 2 });
  assert.deepEqual(document.stats(), { reads: 2, replacements: 0 });

  // 持久化快照只在显式 persist 时读取一次正文。
  assert.equal(persistableDrafts(store.getState())[0]?.text, "hello world");
});

test("first line and empty checks use the bound document without full reads", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const firstLine = `#!/usr/bin/env node ${"x".repeat(4096)}`;
  const document = createFakeDocument(`${firstLine}\nrest`);
  store.getState().attachTextDocument(buffer.id, document);

  const current = store.getState().buffers[0]!;
  assert.equal(filesTextBufferFirstLine(current), firstLine.slice(0, 2048));
  assert.equal(filesTextBufferIsEmpty(current), false);
  assert.deepEqual(document.stats(), { reads: 0, replacements: 0 });

  const empty = createFakeDocument("");
  store.getState().attachTextDocument(buffer.id, empty);
  assert.equal(filesTextBufferIsEmpty(store.getState().buffers[0]!), true);
});

test("updateText and restoreTextContent replace the bound document synchronously", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);

  store.getState().updateText(buffer.id, "external");
  assert.deepEqual(document.stats(), { reads: 0, replacements: 1 });
  const updated = store.getState().buffers[0]!;
  assert.equal(updated.kind === "text" ? updated.text : undefined, "external");
  assert.equal(isFilesBufferDirty(updated), true);

  store.getState().setTextLoadState(buffer.id, "loading");
  store.getState().restoreTextContent(buffer.id, { text: "disk", version: "v1" });
  const restored = store.getState().buffers[0]!;
  assert.equal(restored.kind === "text" ? restored.text : undefined, "disk");
  assert.equal(restored.kind === "text" ? restored.savedText : undefined, "disk");
  assert.equal(isFilesBufferDirty(restored), false);
  assert.equal(snapshotFilesTextBuffer(restored), "disk");
});

test("saving captures one snapshot and input during commit keeps the buffer dirty", async () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);
  store.getState().markSaved(buffer.id, {
    path: "/work/a.ts",
    text: "hello",
    workspace,
    preserveCurrentText: true,
    version: "v1",
  });

  document.type("!");
  store.getState().noteTextDocumentChange(buffer.id);
  const snapshot = captureFilesTextSnapshot(store.getState().buffers[0]!);
  assert.deepEqual(snapshot, { text: "hello!", documentVersionId: 2 });

  let resolveCommit: ((value: CommitTextFileResult) => void) | undefined;
  const started = new Promise<void>((resolve) => {
    const commitTextFile = async (params: CommitTextFileParams) => {
      assert.deepEqual(params.write, { kind: "full", text: "hello!" });
      resolve();
      return await new Promise<CommitTextFileResult>((resolveResult) => {
        resolveCommit = resolveResult;
      });
    };
    void saveFilesTextBuffer({
      store,
      buffer: store.getState().buffers[0]!,
      path: "/work/a.ts",
      fileService: {
        readTextFileWindow: async () =>
          ({
            path: "/work/a.ts",
            content: "",
            offset: 0,
            bytesRead: 0,
            nextOffset: 0,
            totalBytes: 0,
            version: "v1",
            isBinary: false,
            eof: true,
            truncated: false,
          }) as FileTextWindow,
        commitTextFile,
      },
      onConflict: () => assert.fail("unexpected conflict"),
      onSaveFailed: () => assert.fail("unexpected save failure"),
      onBusy: () => undefined,
      onSaved: () => undefined,
    });
  });
  await started;

  // commit await 期间继续输入：保存完成只能把已提交版本设为基准，新输入仍为脏。
  document.type("?");
  store.getState().noteTextDocumentChange(buffer.id);
  resolveCommit!({ path: "/work/a.ts", version: "v2", totalBytes: 6 });
  await new Promise((resolve) => setImmediate(resolve));

  const saved = store.getState().buffers[0]!;
  assert.equal(saved.kind === "text" ? saved.savedText : undefined, "hello!");
  // 提交版本号已给出时不再复制全文：缓冲 text 保留提交快照，正文以模型为准。
  assert.equal(saved.kind === "text" ? saved.text : undefined, "hello!");
  assert.equal(snapshotFilesTextBuffer(saved), "hello!?");
  assert.equal(saved.kind === "text" ? saved.diskVersion : undefined, "v2");
  assert.equal(isFilesBufferDirty(saved), true);
});

test("disk reload started before local input does not overwrite the newer draft", async () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);
  store.getState().markSaved(buffer.id, {
    path: "/work/a.ts",
    text: "hello",
    workspace,
    preserveCurrentText: true,
    version: "v1",
  });

  let resolveRead: ((window: FileTextWindow) => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    const promise = reloadFilesBufferFromDisk({
      store,
      bufferId: buffer.id,
      fileService: {
        readTextFileWindow: async () => {
          resolve();
          return await new Promise<FileTextWindow>((resolveWindow) => {
            resolveRead = resolveWindow;
          });
        },
      },
      isCurrentRequest: () => true,
      persist: () => undefined,
    });
    void promise;
  });
  await readStarted;

  document.type("!");
  store.getState().noteTextDocumentChange(buffer.id);
  resolveRead!({
    path: "/work/a.ts",
    content: "disk",
    offset: 0,
    bytesRead: 4,
    nextOffset: 4,
    totalBytes: 4,
    version: "v2",
    isBinary: false,
    eof: true,
    truncated: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const current = store.getState().buffers[0]!;
  assert.equal(current.kind === "text" ? current.text : undefined, "hello");
  assert.equal(snapshotFilesTextBuffer(current), "hello!");
  assert.equal(isFilesBufferDirty(current), true);
});

test("save-as during commit snapshots the model so post-commit input survives", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);
  document.type("!");
  store.getState().noteTextDocumentChange(buffer.id);

  // 提交快照是 "hello"（版本 1），await 期间又输入了 "!"；另存为会重建缓冲 ID，
  // 新缓冲没有文档绑定，必须用模型快照兜住这段输入。
  store.getState().markSaved(buffer.id, {
    path: "/work/b.ts",
    text: "hello",
    workspace,
    preserveCurrentText: true,
    documentVersionId: 1,
    version: "v2",
  });

  const saved = store.getState().buffers.find((candidate) => candidate.path === "/work/b.ts");
  assert.ok(saved && saved.kind === "text");
  assert.equal(saved.text, "hello!");
  assert.equal(saved.savedText, "hello");
  assert.equal(isFilesBufferDirty(saved), true);
});

test("markSaved with a commit version does not copy the full text again", () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);
  document.type("!");
  store.getState().noteTextDocumentChange(buffer.id);
  const readsBefore = document.stats().reads;

  store.getState().markSaved(buffer.id, {
    path: "/work/a.ts",
    text: "hello!",
    workspace,
    preserveCurrentText: true,
    documentVersionId: document.getVersionId(),
    version: "v1",
  });

  assert.equal(document.stats().reads, readsBefore);
  assert.equal(snapshotFilesTextBuffer(store.getState().buffers[0]!), "hello!");
  assert.equal(isFilesBufferDirty(store.getState().buffers[0]!), false);
});

async function startDeferredReload(
  store: ReturnType<typeof createFilesEditorStore>,
  bufferId: string,
) {
  let resolveRead: ((window: FileTextWindow) => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    void reloadFilesBufferFromDisk({
      store,
      bufferId,
      fileService: {
        readTextFileWindow: async () => {
          resolve();
          return await new Promise<FileTextWindow>((resolveWindow) => {
            resolveRead = resolveWindow;
          });
        },
      },
      isCurrentRequest: () => true,
      persist: () => undefined,
    });
  });
  await readStarted;
  return (window: FileTextWindow) => resolveRead!(window);
}

test("reload started without a binding accepts an equivalent model attached during the read", async () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const resolveRead = await startDeferredReload(store, buffer.id);

  // 读取期间编辑器挂载：新绑定的正文仍等于读取开始时的快照，可以安全替换。
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);
  resolveRead(diskWindow("disk"));
  await new Promise((resolve) => setImmediate(resolve));

  const current = store.getState().buffers[0]!;
  assert.equal(snapshotFilesTextBuffer(current), "disk");
  assert.equal(isFilesBufferDirty(current), false);
});

test("reload started without a binding aborts when the attached model has local input", async () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const resolveRead = await startDeferredReload(store, buffer.id);

  const document = createFakeDocument("hello!");
  store.getState().attachTextDocument(buffer.id, document);
  resolveRead(diskWindow("disk"));
  await new Promise((resolve) => setImmediate(resolve));

  const current = store.getState().buffers[0]!;
  assert.equal(snapshotFilesTextBuffer(current), "hello!");
  assert.equal(current.kind === "text" ? current.text : undefined, "hello");
});

test("reload compares version domains instead of raw alternative version ids", async () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const previous = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, previous);
  const resolveRead = await startDeferredReload(store, buffer.id);

  // 新 model 的替代版本号也可能从 1 开始；数字相同不代表同一个版本域。
  store.getState().detachTextDocument(buffer.id, previous);
  const replacement = createFakeDocument("helloX");
  store.getState().attachTextDocument(buffer.id, replacement);
  assert.equal(replacement.getVersionId(), previous.getVersionId());
  resolveRead(diskWindow("disk"));
  await new Promise((resolve) => setImmediate(resolve));

  const current = store.getState().buffers[0]!;
  assert.equal(snapshotFilesTextBuffer(current), "helloX");
  assert.equal(current.kind === "text" ? current.text : undefined, "hello");
});

test("reload on the same model treats returning to the start version as unchanged", async () => {
  const store = createFilesEditorStore();
  const buffer = openTextBuffer(store);
  const document = createFakeDocument("hello");
  store.getState().attachTextDocument(buffer.id, document);
  const resolveRead = await startDeferredReload(store, buffer.id);

  document.type("!");
  store.getState().noteTextDocumentChange(buffer.id);
  document.undoTo(1);
  store.getState().noteTextDocumentChange(buffer.id);
  resolveRead(diskWindow("disk"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(snapshotFilesTextBuffer(store.getState().buffers[0]!), "disk");
});
