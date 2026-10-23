import assert from "node:assert/strict";
import test from "node:test";
import { resolveFilesEditorMenuState } from "../src/files-workbench/filesEditorMenuContext.js";
import type { FilesBuffer, FilesTextBuffer } from "../src/files-workbench/filesEditorTypes.js";

function textBuffer(overrides: Partial<FilesTextBuffer> = {}): FilesTextBuffer {
  return {
    id: "text",
    kind: "text",
    untitled: true,
    title: "Untitled",
    text: "draft",
    savedText: "",
    workspace: { workspacePath: "/workspace" },
    ...overrides,
  };
}

test("未命名文本可保存，空工作台和只读预览没有保存目标", () => {
  const text = textBuffer();
  const preview: FilesBuffer = {
    id: "preview",
    kind: "preview",
    path: "/workspace/image.png",
    title: "image.png",
    workspace: text.workspace,
  };
  const state = { buffers: [text, preview], openIds: [text.id, preview.id] };
  assert.deepEqual(resolveFilesEditorMenuState({ ...state, activeId: text.id }), {
    hasActiveEditor: true,
    canSave: true,
    dirtyFileCount: 1,
  });
  assert.deepEqual(resolveFilesEditorMenuState({ ...state, activeId: preview.id }), {
    hasActiveEditor: true,
    canSave: false,
    dirtyFileCount: 1,
  });
  assert.deepEqual(resolveFilesEditorMenuState({ buffers: [], openIds: [] }), {
    hasActiveEditor: false,
    canSave: false,
    dirtyFileCount: 0,
  });
});

test("未加载及失败文本不能另存为一个空文件", () => {
  for (const loadState of ["unloaded", "loading", "error"] as const) {
    const buffer = textBuffer({ text: "", savedText: "", untitled: false, loadState });
    const result = resolveFilesEditorMenuState({
      buffers: [buffer],
      openIds: [buffer.id],
      activeId: buffer.id,
    });
    assert.equal(result.hasActiveEditor, true);
    assert.equal(result.canSave, false);
  }
});

test("全部保存投影跨工作区，仅统计脏文本缓冲", () => {
  const first = textBuffer();
  const second = textBuffer({
    id: "remote",
    workspace: { workspacePath: "/workspace", workspaceIdentity: "remote-identity" },
  });
  const clean = textBuffer({ id: "clean", text: "", savedText: "" });
  const result = resolveFilesEditorMenuState({
    buffers: [first, second, clean],
    openIds: [first.id, second.id, clean.id],
    activeId: first.id,
  });
  assert.equal(result.dirtyFileCount, 2);
});
