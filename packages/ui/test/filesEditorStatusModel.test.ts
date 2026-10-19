import assert from "node:assert/strict";
import test from "node:test";
import {
  filesEditorEolFromMonaco,
  filesEditorIndentKind,
  filesEditorMarkerCounts,
  filesEditorResolveGotoLine,
  filesEditorSortMarkers,
  filesEditorStatusEqual,
} from "../src/files-workbench/filesEditorStatusModel.js";
import type {
  FilesEditorStatusMarker,
  FilesEditorStatusSnapshot,
} from "../src/files-workbench/filesEditorStatusModel.js";

// 文件工作台状态栏的纯模型层（docs/specs/files-editor-status-bar.md）。
// 这里只覆盖不依赖 React / Monaco 的部分：类型判定、计数、排序与跳转校验。

function snapshot(overrides: Partial<FilesEditorStatusSnapshot> = {}): FilesEditorStatusSnapshot {
  return {
    lineNumber: 1,
    column: 1,
    lineCount: 10,
    languageId: "typescript",
    indentKind: "spaces",
    tabSize: 2,
    eol: "LF",
    ...overrides,
  };
}

function marker(overrides: Partial<FilesEditorStatusMarker> = {}): FilesEditorStatusMarker {
  return {
    id: "ts:1:1:0",
    severity: "error",
    message: "Unexpected token",
    lineNumber: 1,
    column: 1,
    ...overrides,
  };
}

test("缩进类型：insertSpaces 决定空格还是制表符", () => {
  assert.equal(filesEditorIndentKind(true), "spaces");
  assert.equal(filesEditorIndentKind(false), "tabs");
});

test("换行符：只有 CRLF 认，其余一律 LF", () => {
  assert.equal(filesEditorEolFromMonaco("\r\n"), "CRLF");
  assert.equal(filesEditorEolFromMonaco("\n"), "LF");
  assert.equal(filesEditorEolFromMonaco(undefined), "LF");
});

test("快照比较：任一字段变化都算不等", () => {
  assert.equal(filesEditorStatusEqual(snapshot(), snapshot()), true);
  assert.equal(filesEditorStatusEqual(snapshot(), snapshot({ lineNumber: 2 })), false);
  assert.equal(filesEditorStatusEqual(snapshot(), snapshot({ column: 5 })), false);
  assert.equal(filesEditorStatusEqual(snapshot(), snapshot({ lineCount: 20 })), false);
  assert.equal(filesEditorStatusEqual(snapshot(), snapshot({ languageId: "json" })), false);
  assert.equal(filesEditorStatusEqual(snapshot(), snapshot({ indentKind: "tabs" })), false);
  assert.equal(filesEditorStatusEqual(snapshot(), snapshot({ tabSize: 4 })), false);
  assert.equal(filesEditorStatusEqual(snapshot(), snapshot({ eol: "CRLF" })), false);
});

test("诊断计数：只算错误与警告，info 不计", () => {
  const counts = filesEditorMarkerCounts([
    marker({ id: "a", severity: "error" }),
    marker({ id: "b", severity: "error" }),
    marker({ id: "c", severity: "warning" }),
    marker({ id: "d", severity: "info" }),
  ]);
  assert.deepEqual(counts, { errors: 2, warnings: 1 });
});

test("诊断排序：错误在前，同级按行列升序", () => {
  const sorted = filesEditorSortMarkers([
    marker({ id: "w", severity: "warning", lineNumber: 2, column: 1 }),
    marker({ id: "e2", severity: "error", lineNumber: 5, column: 1 }),
    marker({ id: "e1", severity: "error", lineNumber: 1, column: 9 }),
    marker({ id: "e1b", severity: "error", lineNumber: 1, column: 2 }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["e1b", "e1", "e2", "w"],
  );
});

test("跳转到行：非法行号不动作", () => {
  assert.equal(filesEditorResolveGotoLine("12", 100), 12);
  assert.equal(filesEditorResolveGotoLine(" 7 ", 100), 7);
  assert.equal(filesEditorResolveGotoLine("0", 100), undefined);
  assert.equal(filesEditorResolveGotoLine("-3", 100), undefined);
  assert.equal(filesEditorResolveGotoLine("abc", 100), undefined);
  assert.equal(filesEditorResolveGotoLine("", 100), undefined);
  // 超出文件行数不动作
  assert.equal(filesEditorResolveGotoLine("101", 100), undefined);
});
