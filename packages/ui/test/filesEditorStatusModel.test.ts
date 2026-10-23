import assert from "node:assert/strict";
import test from "node:test";
import {
  filesEditorEolFromMonaco,
  filesEditorFilterLanguages,
  filesEditorIndentKind,
  filesEditorLanguageDescription,
  filesEditorLanguageLabel,
  filesEditorLanguageLabelById,
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
  return { id, label: filesEditorLanguageLabel({ id, aliases }), aliases, extensions };
}

test("语言显示名：使用首个规范别名，没有别名时回退到语言 id", () => {
  assert.equal(filesEditorLanguageLabel(language("json", ["JSON", "json"])), "JSON");
  assert.equal(
    filesEditorLanguageLabel(language("plaintext", ["Plain Text", "text"])),
    "Plain Text",
  );
  assert.equal(filesEditorLanguageLabel(language("custom-language")), "custom-language");
});

test("状态栏语言显示名：按 id 取规范名，注册表查不到时回退 id", () => {
  const languages = [
    language("typescript", ["TypeScript", "ts", "typescript"], [".ts", ".tsx"]),
    language("makefile"),
  ];
  assert.equal(filesEditorLanguageLabelById("typescript", languages), "TypeScript");
  assert.equal(filesEditorLanguageLabelById("makefile", languages), "makefile");
  assert.equal(filesEditorLanguageLabelById("not-registered", languages), "not-registered");
});

test("语言列表：按流行度降序，没有份额数据的语言垫底", () => {
  const sorted = filesEditorFilterLanguages(
    [language("flow9"), language("typescript"), language("zzz-unknown-language"), language("json")],
    "",
  );
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["json", "typescript", "flow9", "zzz-unknown-language"],
  );
});

test("语言列表：常见语言按调研份额排在前面", () => {
  const sorted = filesEditorFilterLanguages(
    [
      language("plaintext"),
      language("css"),
      language("markdown"),
      language("typescript"),
      language("msdax"),
    ],
    "",
  );
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["markdown", "plaintext", "css", "typescript", "msdax"],
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

test("语言搜索：扩展名只在查询以 . 开头时参与匹配", () => {
  // Monaco 0.57 的真实注册数据：XML 含 .targets、Kotlin 含 .kts，
  // 无条件按子串匹配扩展名时，搜「ts」会被 XML、Kotlin 刷屏（用户实测回归）。
  const languages = [
    language("xml", ["XML", "xml"], [".xml", ".xsd", ".targets", ".xslt", ".svg"]),
    language("kotlin", ["Kotlin", "kotlin"], [".kt", ".kts"]),
    language("typescript", ["TypeScript", "ts", "typescript"], [".ts", ".tsx"]),
    language("postiats", ["ATS", "ATS/Postiats"], [".dats", ".sats", ".hats"]),
  ];
  // 「ts」只命中 id/别名里含 ts 的语言；typescript 流行度高于 postiats，排在前。
  assert.deepEqual(
    filesEditorFilterLanguages(languages, "ts").map((item) => item.id),
    ["typescript", "postiats"],
  );
  // 显式按扩展名搜仍然可用。
  assert.deepEqual(
    filesEditorFilterLanguages(languages, ".kts").map((item) => item.id),
    ["kotlin"],
  );
  assert.deepEqual(
    filesEditorFilterLanguages(languages, ".tsx").map((item) => item.id),
    ["typescript"],
  );
  assert.deepEqual(
    filesEditorFilterLanguages(languages, ".ts").map((item) => item.id),
    ["typescript"],
  );
});

test("语言说明：隐藏首个显示别名，展示其余别名或扩展名", () => {
  assert.equal(
    filesEditorLanguageDescription(language("json", ["JSON", "json"], [".json"])),
    "json",
  );
  assert.equal(
    filesEditorLanguageDescription(language("freemarker2", ["Apache FreeMarker2"], [".ftl"])),
    ".ftl",
  );
  assert.equal(filesEditorLanguageDescription(language("makefile", [], [".mk"])), ".mk");
  assert.equal(filesEditorLanguageDescription(language("plaintext")), undefined);
});
