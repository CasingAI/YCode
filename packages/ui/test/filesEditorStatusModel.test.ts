import assert from "node:assert/strict";
import test from "node:test";
import {
  filesEditorEolFromMonaco,
  filesEditorFilterLanguages,
  filesEditorIndentKind,
  filesEditorLanguageDescription,
  filesEditorMarkerCounts,
  filesEditorResolveGotoLine,
  filesEditorSortMarkers,
  filesEditorStatusEqual,
} from "../src/files-workbench/filesEditorStatusModel.js";
import type {
  FilesEditorStatusLanguage,
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

function language(
  id: string,
  aliases: readonly string[] = [],
  extensions: readonly string[] = [],
): FilesEditorStatusLanguage {
  return { id, label: id, aliases, extensions };
}

test("语言列表：按流行度降序，无份额数据的语言垫底并按 id 升序", () => {
  const sorted = filesEditorFilterLanguages(
    [language("flow9"), language("typescript"), language("freemarker2"), language("json")],
    "",
  );
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["typescript", "json", "flow9", "freemarker2"],
  );
});

test("语言列表：常见语言按调研份额排在前面", () => {
  const sorted = filesEditorFilterLanguages(
    [
      language("plaintext"),
      language("python"),
      language("javascript"),
      language("markdown"),
      language("msdax"),
    ],
    "",
  );
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["javascript", "python", "markdown", "plaintext", "msdax"],
  );
});

test("语言列表：查询同时命中 id、别名与扩展名", () => {
  const languages = [
    language("freemarker2", ["Apache FreeMarker2"], [".ftl"]),
    language("freemarker2.tag-angle.interpolation-bracket", ["FreeMarker2 (Angle/Bracket)"]),
    language("typescript"),
  ];
  assert.deepEqual(
    filesEditorFilterLanguages(languages, "angle").map((item) => item.id),
    ["freemarker2.tag-angle.interpolation-bracket"],
  );
  assert.deepEqual(
    filesEditorFilterLanguages(languages, "freemarker2").map((item) => item.id),
    ["freemarker2", "freemarker2.tag-angle.interpolation-bracket"],
  );
  assert.deepEqual(
    filesEditorFilterLanguages(languages, ".ftl").map((item) => item.id),
    ["freemarker2"],
  );
  assert.deepEqual(filesEditorFilterLanguages(languages, "nope"), []);
});

test("语言说明：优先别名，其次扩展名，都没有则不显示", () => {
  assert.equal(
    filesEditorLanguageDescription(language("freemarker2", ["Apache FreeMarker2"], [".ftl"])),
    "Apache FreeMarker2",
  );
  assert.equal(filesEditorLanguageDescription(language("makefile", [], [".mk"])), ".mk");
  assert.equal(filesEditorLanguageDescription(language("plaintext")), undefined);
});
