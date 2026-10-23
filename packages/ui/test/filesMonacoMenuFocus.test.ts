import assert from "node:assert/strict";
import test from "node:test";
import type * as Monaco from "monaco-editor";
import { createFilesMonacoStatusHandle } from "../src/files-workbench/filesMonacoStatusHandle.js";

test("菜单撤销 / 重做后恢复编辑器焦点，用户可以继续输入", () => {
  const calls: string[] = [];
  const subscribe = () => ({ dispose() {} });
  const model = {
    getOptions: () => ({ insertSpaces: true, tabSize: 2 }),
    getLineCount: () => 1,
    getLanguageId: () => "plaintext",
    getEOL: () => "\n",
    onDidChangeContent: subscribe,
    onDidChangeOptions: subscribe,
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
  };
  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    hasTextFocus: () => false,
    onDidChangeCursorPosition: subscribe,
    onDidChangeConfiguration: subscribe,
    onDidChangeModel: subscribe,
    onDidFocusEditorWidget: subscribe,
    onDidBlurEditorWidget: subscribe,
    focus: () => calls.push("focus"),
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  const monaco = {
    editor: {
      getModelMarkers: () => [],
      onDidChangeModelLanguage: subscribe,
      onDidChangeMarkers: subscribe,
    },
  } as unknown as typeof Monaco;
  const handle = createFilesMonacoStatusHandle(monaco, editor);
  try {
    handle.undo();
    handle.redo();
    assert.deepEqual(calls, ["undo", "focus", "redo", "focus"]);
  } finally {
    handle.dispose();
  }
});
