import assert from "node:assert/strict";
import test from "node:test";
import { UiCommandIds } from "@zcode/shared";
import { executeEditMenuCommand } from "../src/shortcuts/editMenuCommand.js";
import { registerEditCommandTarget } from "../src/shortcuts/editCommandTarget.js";

test("菜单编辑动作复用当前界面的目标，失焦后仍能查找和替换", () => {
  const calls: string[] = [];
  const dispose = registerEditCommandTarget({
    kind: "editor",
    isFocused: () => false,
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
    find: (options) => {
      calls.push(options?.replace ? "replace" : "find");
      return true;
    },
  });
  try {
    for (const command of [
      UiCommandIds.Undo,
      UiCommandIds.Redo,
      UiCommandIds.FindInEditor,
      UiCommandIds.FindReplaceInEditor,
    ]) {
      assert.equal(executeEditMenuCommand(command, "files"), true);
    }
    assert.deepEqual(calls, ["undo", "redo", "find", "replace"]);
    assert.equal(executeEditMenuCommand(UiCommandIds.SaveFile, "files"), false);
    assert.equal(executeEditMenuCommand(UiCommandIds.Undo, "tasks"), false);
  } finally {
    dispose();
  }
});

test("未登记目标时不执行菜单编辑命令", () => {
  assert.equal(executeEditMenuCommand(UiCommandIds.Undo, "files"), false);
  assert.equal(executeEditMenuCommand(UiCommandIds.FindInEditor, "files"), false);
});
