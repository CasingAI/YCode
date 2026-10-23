import assert from "node:assert/strict";
import test from "node:test";
import { UiCommandIds, type UiCommandId } from "@zcode/shared";
import { executeFilesEditorFileCommand } from "../src/files-workbench/filesEditorFileCommands.js";

type CommandContext = Parameters<typeof executeFilesEditorFileCommand>[1];

function createContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    isActiveView: true,
    canCreateFile: true,
    editor: { hasActiveEditor: true, canSave: true, dirtyFileCount: 1 },
    ...overrides,
  };
}

function createActions() {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      saveActiveFile: async () => {
        calls.push("save");
        return true;
      },
      saveActiveFileAs: () => {
        calls.push("saveAs");
        return true;
      },
      saveAllFiles: async () => {
        calls.push("saveAll");
      },
      onCreateUntitled: () => {
        calls.push("new");
      },
    },
  };
}

const SAVE_COMMANDS = [
  UiCommandIds.SaveFile,
  UiCommandIds.SaveFileAs,
  UiCommandIds.SaveAllFiles,
] as const;

test("每条可用文件命令只调用对应的一个动作", () => {
  const cases: Array<[UiCommandId, string]> = [
    [UiCommandIds.SaveFile, "save"],
    [UiCommandIds.SaveFileAs, "saveAs"],
    [UiCommandIds.SaveAllFiles, "saveAll"],
    [UiCommandIds.NewFile, "new"],
  ];
  for (const [command, expected] of cases) {
    const { calls, actions } = createActions();
    assert.equal(executeFilesEditorFileCommand(command, createContext(), actions), true);
    assert.deepEqual(calls, [expected]);
  }
});

test("切走文件主视图后过期保存命令不修改保活工作台", () => {
  for (const command of SAVE_COMMANDS) {
    const { calls, actions } = createActions();
    assert.equal(
      executeFilesEditorFileCommand(command, createContext({ isActiveView: false }), actions),
      false,
    );
    assert.deepEqual(calls, []);
  }
});

test("非文本或无活动标签时保存与另存为不执行", () => {
  for (const hasActiveEditor of [true, false]) {
    for (const command of [UiCommandIds.SaveFile, UiCommandIds.SaveFileAs]) {
      const { calls, actions } = createActions();
      const context = createContext({
        editor: { hasActiveEditor, canSave: false, dirtyFileCount: 0 },
      });
      assert.equal(executeFilesEditorFileCommand(command, context, actions), false);
      assert.deepEqual(calls, []);
    }
  }
});

test("干净文本和未命名文本仍可保存与另存为", () => {
  for (const command of [UiCommandIds.SaveFile, UiCommandIds.SaveFileAs]) {
    const { calls, actions } = createActions();
    const context = createContext({
      editor: { hasActiveEditor: true, canSave: true, dirtyFileCount: 0 },
    });
    assert.equal(executeFilesEditorFileCommand(command, context, actions), true);
    assert.equal(calls.length, 1);
  }
});

test("未命名保存进入选路并返回 false 时命令仍已处理且不重复调用", () => {
  const { calls, actions } = createActions();
  actions.saveActiveFile = async () => {
    calls.push("pausedForSaveAs");
    return false;
  };
  assert.equal(
    executeFilesEditorFileCommand(UiCommandIds.SaveFile, createContext(), actions),
    true,
  );
  assert.deepEqual(calls, ["pausedForSaveAs"]);
});

test("另存为动作返回 false 时不回落到普通保存或重复执行", () => {
  const { calls, actions } = createActions();
  actions.saveActiveFileAs = () => {
    calls.push("saveAs");
    return false;
  };
  assert.equal(
    executeFilesEditorFileCommand(UiCommandIds.SaveFileAs, createContext(), actions),
    true,
  );
  assert.deepEqual(calls, ["saveAs"]);
});

test("全部保存只看所有缓冲的脏文本数量，不依赖活动标签类型", () => {
  for (const dirtyFileCount of [0, 2]) {
    const { calls, actions } = createActions();
    const context = createContext({
      editor: { hasActiveEditor: true, canSave: false, dirtyFileCount },
    });
    assert.equal(
      executeFilesEditorFileCommand(UiCommandIds.SaveAllFiles, context, actions),
      dirtyFileCount > 0,
    );
    assert.deepEqual(calls, dirtyFileCount > 0 ? ["saveAll"] : []);
  }
});

test("有工作区时新建在文件与其它主视图均可执行", () => {
  for (const isActiveView of [true, false]) {
    const { calls, actions } = createActions();
    const context = createContext({
      isActiveView,
      editor: { hasActiveEditor: false, canSave: false, dirtyFileCount: 0 },
    });
    assert.equal(executeFilesEditorFileCommand(UiCommandIds.NewFile, context, actions), true);
    assert.deepEqual(calls, ["new"]);
  }
});

test("没有可用工作区时任何主视图都不执行新建", () => {
  for (const isActiveView of [true, false]) {
    const { calls, actions } = createActions();
    const context = createContext({ isActiveView, canCreateFile: false });
    assert.equal(executeFilesEditorFileCommand(UiCommandIds.NewFile, context, actions), false);
    assert.deepEqual(calls, []);
  }
});

test("无关命令不调用文件动作", () => {
  const { calls, actions } = createActions();
  assert.equal(executeFilesEditorFileCommand(UiCommandIds.Undo, createContext(), actions), false);
  assert.deepEqual(calls, []);
});
