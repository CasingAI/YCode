import assert from "node:assert/strict";
import test from "node:test";
import { UiCommandIds, desktopMenuMessageIds } from "@zcode/shared";
import { buildFilesWorkbenchMenuItems } from "../src/files-workbench/filesWorkbenchMenuItems.js";

test("空工作台保留文件与编辑菜单，只有新建可用", () => {
  const items = buildFilesWorkbenchMenuItems({
    state: { hasActiveEditor: false, canSave: false, dirtyFileCount: 0 },
    canEdit: false,
    canCreateFile: true,
  });

  assert.deepEqual(
    items.file.map((item) => item.messageId),
    [
      desktopMenuMessageIds.fileNewFile,
      desktopMenuMessageIds.fileSave,
      desktopMenuMessageIds.fileSaveAs,
      desktopMenuMessageIds.fileSaveAll,
      desktopMenuMessageIds.fileCloseEditor,
    ],
  );
  assert.deepEqual(
    items.file.map((item) => item.disabled),
    [false, true, true, true, true],
  );
  assert.deepEqual(
    items.edit.map((item) => item.disabled),
    [true, true, true, true],
  );
});

test("文本标签（含未命名与未修改文本）可保存、另存为与编辑", () => {
  const items = buildFilesWorkbenchMenuItems({
    state: { hasActiveEditor: true, canSave: true, dirtyFileCount: 0 },
    canEdit: true,
    canCreateFile: true,
  });

  assert.deepEqual(
    items.file.map((item) => item.disabled),
    [false, false, false, true, false],
  );
  assert.deepEqual(
    items.edit.map((item) => item.command),
    [
      UiCommandIds.Undo,
      UiCommandIds.Redo,
      UiCommandIds.FindInEditor,
      UiCommandIds.FindReplaceInEditor,
    ],
  );
  assert.ok(items.edit.every((item) => !item.disabled));
});

test("只读预览可关闭；其它工作区的脏文本仍能全部保存", () => {
  const items = buildFilesWorkbenchMenuItems({
    state: { hasActiveEditor: true, canSave: false, dirtyFileCount: 2 },
    canEdit: false,
    canCreateFile: true,
  });

  assert.deepEqual(
    items.file.map((item) => item.disabled),
    [false, true, true, false, false],
  );
  assert.ok(items.edit.every((item) => item.disabled));
});

test("快捷键关联采用已有命令 id，查找复用 findInTask，关闭复用 closeActiveContext", () => {
  const items = buildFilesWorkbenchMenuItems({
    state: { hasActiveEditor: true, canSave: true, dirtyFileCount: 1 },
    canEdit: true,
    canCreateFile: true,
  });

  assert.deepEqual(
    items.file.map((item) => item.shortcutId),
    ["newFile", "saveFile", "saveFileAs", "saveAllFiles", "closeActiveContext"],
  );
  assert.deepEqual(
    items.edit.map((item) => item.shortcutId),
    [undefined, undefined, "findInTask", "findReplaceInEditor"],
  );
  assert.equal(items.file.at(-1)?.command, undefined);
});

test("没有可用工作区时新建禁用，不呈现点了无效的入口", () => {
  const items = buildFilesWorkbenchMenuItems({
    state: { hasActiveEditor: false, canSave: false, dirtyFileCount: 0 },
    canEdit: false,
    canCreateFile: false,
  });
  assert.ok(items.file.every((item) => item.disabled));
});
