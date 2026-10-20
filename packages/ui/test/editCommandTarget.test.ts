import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getEditCommandTarget,
  getLastFocusedEditCommandTarget,
  registerEditCommandTarget,
  resolveEditCommandTarget,
  setEditCommandTargetFocused,
  type EditCommandTarget,
} from "../src/shortcuts/editCommandTarget.js";
import { dispatchFindCommand, dispatchFindReplaceCommand } from "../src/shortcuts/findCommand.js";

/**
 * 编辑目标注册表与查找分派：
 * 桌面菜单的编辑命令作用在「操作前获得过焦点」的目标上，规则见
 * docs/specs/desktop-application-menu.md「编辑菜单作用于正确的输入区域」。
 */

function createTarget(
  kind: "editor" | "composer",
  overrides?: { focused?: boolean; findResult?: boolean },
): EditCommandTarget & { undoCount: number; redoCount: number; findCount: number } {
  const target = {
    kind,
    focused: overrides?.focused ?? false,
    undoCount: 0,
    redoCount: 0,
    findCount: 0,
    isFocused: () => target.focused,
    undo: () => {
      target.undoCount += 1;
    },
    redo: () => {
      target.redoCount += 1;
    },
    find: () => {
      target.findCount += 1;
      return overrides?.findResult ?? true;
    },
  };
  return target;
}

const cleanups: Array<() => void> = [];

function register(target: EditCommandTarget, focused?: boolean): EditCommandTarget {
  cleanups.push(registerEditCommandTarget(target, { focused }));
  return target;
}

/**
 * 编辑器的接线：先登记句柄，等它真的拿到焦点时再登记「最近聚焦目标」
 * （Monaco 的焦点事件在 useFilesEditorMenuCommands 里转成本模块的调用）。
 */
function registerEditor(target: EditCommandTarget): { focus: () => void } {
  register(target);
  return {
    focus: () => {
      target.isFocused = () => true;
      setEditCommandTargetFocused(target, true);
    },
  };
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("编辑目标注册表", () => {
  it("最近聚焦过的目标优先于界面兜底", () => {
    const composer = register(createTarget("composer", { focused: true }), true);
    const editor = register(createTarget("editor", { focused: true }), true);

    assert.equal(getLastFocusedEditCommandTarget(), editor);
    assert.equal(resolveEditCommandTarget("files"), editor);
    assert.equal(resolveEditCommandTarget("tasks"), editor);
    assert.equal(composer.kind, "composer");
  });

  it("编辑器拿到焦点后成为最近聚焦目标", () => {
    const editor = createTarget("editor");
    const editorBinding = registerEditor(editor);

    assert.equal(getLastFocusedEditCommandTarget(), null);

    editorBinding.focus();

    assert.equal(getLastFocusedEditCommandTarget(), editor);
    assert.equal(resolveEditCommandTarget("files"), editor);
  });

  it("目标已失焦时按当前界面兜底", () => {
    const editor = register(createTarget("editor", { focused: false }), false);
    const composer = register(createTarget("composer", { focused: false }), false);
    editor.isFocused = () => false;
    composer.isFocused = () => false;

    assert.equal(resolveEditCommandTarget("files"), editor);
    assert.equal(resolveEditCommandTarget("tasks"), composer);
    assert.equal(resolveEditCommandTarget("settings"), composer);
  });

  it("没有登记目标时返回 null", () => {
    assert.equal(resolveEditCommandTarget("files"), null);
    assert.equal(getLastFocusedEditCommandTarget(), null);
    assert.equal(getEditCommandTarget("editor"), null);
  });

  it("注销只清理仍指向该目标的记录", () => {
    const first = createTarget("editor");
    const second = createTarget("editor");
    const unregisterFirst = registerEditCommandTarget(first);
    register(second);

    unregisterFirst();

    assert.equal(getEditCommandTarget("editor"), second);
  });
});

describe("查找命令分派", () => {
  it("任务界面查对话", () => {
    let opened = 0;
    const outcome = dispatchFindCommand({
      view: "tasks",
      openTaskFind: () => {
        opened += 1;
      },
    });

    assert.equal(outcome, "handled");
    assert.equal(opened, 1);
  });

  it("设置界面查对话", () => {
    let opened = 0;
    const outcome = dispatchFindCommand({
      view: "settings",
      openTaskFind: () => {
        opened += 1;
      },
    });

    assert.equal(outcome, "handled");
    assert.equal(opened, 1);
  });

  it("文件界面里编辑器持有焦点时放行给编辑器", () => {
    const editor = register(createTarget("editor", { focused: true }), true);

    const outcome = dispatchFindCommand({ view: "files", openTaskFind: () => undefined });

    assert.equal(outcome, "pass-through");
    assert.equal(editor.findCount, 0);
  });

  it("文件界面里编辑器没有焦点时把查找送到编辑器", () => {
    const editor = register(createTarget("editor", { focused: false }), false);

    const outcome = dispatchFindCommand({ view: "files", openTaskFind: () => undefined });

    assert.equal(outcome, "handled");
    assert.equal(editor.findCount, 1);
  });

  it("文件界面里没有编辑器时放行", () => {
    const outcome = dispatchFindCommand({ view: "files", openTaskFind: () => undefined });

    assert.equal(outcome, "pass-through");
  });
});

describe("查找替换命令分派", () => {
  it("文件界面里把查找替换送到编辑器", () => {
    const editor = register(createTarget("editor"));

    const outcome = dispatchFindReplaceCommand({ view: "files" });

    assert.equal(outcome, "handled");
    assert.equal(editor.findCount, 1);
  });

  it("非文件界面不处理", () => {
    register(createTarget("editor"));

    assert.equal(dispatchFindReplaceCommand({ view: "tasks" }), "pass-through");
    assert.equal(dispatchFindReplaceCommand({ view: "settings" }), "pass-through");
  });

  it("没有编辑器时放行", () => {
    assert.equal(dispatchFindReplaceCommand({ view: "files" }), "pass-through");
  });
});
