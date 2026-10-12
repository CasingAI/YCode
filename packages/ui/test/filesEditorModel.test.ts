import assert from "node:assert/strict";
import test from "node:test";
import {
  closeBufferInState,
  createPreviewBuffer,
  createTextFileBuffer,
  createUntitledTextBuffer,
  detectFilesSaveConflict,
  filesFileBufferId,
  filesWorkspaceKey,
  isFilesBufferDirty,
  needsFilesWorkspaceDisambiguation,
  openBufferInState,
  persistableDrafts,
  persistableOpenTabs,
  resolveExplorerWorkspaceKey,
  updateTextBuffer,
} from "../src/files-workbench/filesEditorModel.js";
import type { FilesEditorState, FilesWorkspaceRef } from "../src/files-workbench/filesEditorTypes.js";

const workspaceA: FilesWorkspaceRef = { workspacePath: "/tmp/a" };
const workspaceB: FilesWorkspaceRef = {
  workspacePath: "/tmp/b",
  workspaceIdentity: "remote-b",
};

function emptyState(): FilesEditorState {
  return { buffers: [], openIds: [], untitledSerial: 1 };
}

test("工作区隔离 key 优先 identity", () => {
  assert.equal(filesWorkspaceKey(workspaceA), "/tmp/a");
  assert.equal(filesWorkspaceKey(workspaceB), "remote-b");
});

test("同一工作区同一路径只聚焦已有标签", () => {
  const first = createTextFileBuffer({ workspace: workspaceA, path: "/tmp/a/readme.md", text: "hi" });
  const opened = openBufferInState(emptyState(), first);
  const again = openBufferInState(opened, {
    ...first,
    text: "stale",
  });
  assert.equal(again.buffers.length, 1);
  assert.equal(again.buffers[0]?.text, "hi");
  assert.deepEqual(again.openIds, [first.id]);
  assert.equal(again.activeId, first.id);
});

test("不同工作区的同名路径是两张标签", () => {
  const left = createTextFileBuffer({ workspace: workspaceA, path: "src/app.ts", text: "a" });
  const right = createTextFileBuffer({ workspace: workspaceB, path: "src/app.ts", text: "b" });
  assert.notEqual(left.id, right.id);
  const state = openBufferInState(openBufferInState(emptyState(), left), right);
  assert.equal(state.buffers.length, 2);
  assert.equal(needsFilesWorkspaceDisambiguation(state.buffers, left), true);
});

test("未改过的未命名空标签不算脏；预览也不算脏", () => {
  const untitled = createUntitledTextBuffer({
    id: "untitled:1",
    title: "Untitled-1",
    workspace: workspaceA,
  });
  assert.equal(isFilesBufferDirty(untitled), false);
  untitled.text = "x";
  assert.equal(isFilesBufferDirty(untitled), true);
  const preview = createPreviewBuffer({ workspace: workspaceA, path: "/tmp/a/pic.png" });
  assert.equal(isFilesBufferDirty(preview), false);
});

test("保存冲突只在磁盘既不等于基准也不等于当前正文时出现", () => {
  assert.equal(
    detectFilesSaveConflict({ currentText: "a", savedText: "a", diskText: undefined }),
    "ok",
  );
  assert.equal(
    detectFilesSaveConflict({ currentText: "b", savedText: "a", diskText: "a" }),
    "ok",
  );
  assert.equal(
    detectFilesSaveConflict({ currentText: "b", savedText: "a", diskText: "b" }),
    "ok",
  );
  assert.equal(
    detectFilesSaveConflict({ currentText: "b", savedText: "a", diskText: "c" }),
    "conflict",
  );
});

test("下拉记忆项消失时回退到第一项", () => {
  assert.equal(resolveExplorerWorkspaceKey({ workspaceKeys: [] }), undefined);
  assert.equal(
    resolveExplorerWorkspaceKey({ preferredKey: "gone", workspaceKeys: ["one", "two"] }),
    "one",
  );
  assert.equal(
    resolveExplorerWorkspaceKey({ preferredKey: "two", workspaceKeys: ["one", "two"] }),
    "two",
  );
});

test("只持久化脏草稿；干净路径靠 openTabs 恢复", () => {
  const dirty = createTextFileBuffer({ workspace: workspaceA, path: "/tmp/a/a.ts", text: "new" });
  dirty.savedText = "old";
  const clean = createTextFileBuffer({ workspace: workspaceA, path: "/tmp/a/b.ts", text: "same" });
  const preview = createPreviewBuffer({ workspace: workspaceA, path: "/tmp/a/c.png" });
  const state: FilesEditorState = {
    buffers: [dirty, clean, preview],
    openIds: [dirty.id, clean.id, preview.id],
    untitledSerial: 1,
  };
  assert.deepEqual(
    persistableDrafts(state).map((draft) => draft.id),
    [dirty.id],
  );
  assert.deepEqual(
    persistableOpenTabs(state).map((tab) => tab.id),
    [dirty.id, clean.id, preview.id],
  );
});

test("关闭焦点标签后焦点落到左侧邻居", () => {
  const first = createTextFileBuffer({ workspace: workspaceA, path: "/tmp/a/a.ts", text: "a" });
  const second = createTextFileBuffer({ workspace: workspaceA, path: "/tmp/a/b.ts", text: "b" });
  const opened = openBufferInState(openBufferInState(emptyState(), first), second);
  const closed = closeBufferInState(opened, second.id);
  assert.equal(closed.activeId, first.id);
  assert.equal(closed.buffers.length, 1);
});

test("缓冲身份带工作区 key 与路径", () => {
  assert.equal(filesFileBufferId(workspaceB, "/src/x.ts"), "file:remote-b:/src/x.ts");
});

test("正文未变时 updateTextBuffer 保持同一份状态，避免编辑器回写空转", () => {
  const buffer = createTextFileBuffer({ workspace: workspaceA, path: "/tmp/a/a.ts", text: "same" });
  const state = openBufferInState(emptyState(), buffer);
  const next = updateTextBuffer(state, buffer.id, { text: "same" });
  assert.equal(next, state);
  const changed = updateTextBuffer(state, buffer.id, { text: "other" });
  assert.notEqual(changed, state);
  assert.equal(changed.buffers[0]?.kind === "text" ? changed.buffers[0].text : undefined, "other");
});
