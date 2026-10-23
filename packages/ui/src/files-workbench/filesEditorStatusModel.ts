/**
 * 文件工作台状态栏的纯模型层。
 *
 * 这里只放结构化数据与纯函数：不引入 React，也不引入 Monaco 类型，
 * 方便单测直接覆盖（见 packages/ui/test/filesEditorStatusBar.test.ts）。
 * 规格见 docs/specs/files-editor-status-bar.md。
 */

import { compareFilesEditorLanguageIdsByPopularity } from "@/files-workbench/filesEditorLanguagePopularity.js";

/** 换行符序列。状态栏只展示这两种。 */
export type FilesEditorEol = "LF" | "CRLF";

/** 缩进类型。 */
export type FilesEditorIndentKind = "spaces" | "tabs";

/** 诊断严重度。Monaco 的 Hint/Info 在状态栏不计数。 */
export type FilesEditorMarkerSeverity = "error" | "warning" | "info";

/** 状态栏快照：全部来自当前编辑器实例的真实状态。 */
export interface FilesEditorStatusSnapshot {
  lineNumber: number;
  column: number;
  lineCount: number;
  languageId: string;
  indentKind: FilesEditorIndentKind;
  tabSize: number;
  eol: FilesEditorEol;
}

/** 一条诊断。 */
export interface FilesEditorStatusMarker {
  id: string;
  severity: FilesEditorMarkerSeverity;
  message: string;
  lineNumber: number;
  column: number;
}

/** 缩进大小候选项。 */
export const FILES_EDITOR_INDENT_SIZES: readonly number[] = [2, 4, 8];

/**
 * 可切换的语言。
 *
 * id 用于切换语言和文件关联；别名与扩展名来自 Monaco 注册表，
 * 首个别名作为浮层的可读名称，其余信息作为补充说明。
 */
export interface FilesEditorStatusLanguage {
  id: string;
  label: string;
  aliases: readonly string[];
  extensions: readonly string[];
}

/** 语言浮层使用 Monaco 的首个别名作为可读名称，没有别名时回退到稳定 id。 */
export function filesEditorLanguageLabel(
  language: Pick<FilesEditorStatusLanguage, "id" | "aliases">,
): string {
  return language.aliases[0] ?? language.id;
}

/**
 * 状态栏语言项的显示名：与浮层行同源，按当前语言 id 取规范名（首个别名）。
 * 注册表里查不到该 id 时回退到原始 id（语言列表尚未加载、或产品注册了
 * 排名表之外的 id），保证状态栏永远有字可显。
 */
export function filesEditorLanguageLabelById(
  languageId: string,
  languages: readonly FilesEditorStatusLanguage[],
): string {
  return languages.find((language) => language.id === languageId)?.label ?? languageId;
}

/** Monaco 的 insertSpaces 布尔值 → 状态栏语义。 */
export function filesEditorIndentKind(insertSpaces: boolean): FilesEditorIndentKind {
  return insertSpaces ? "spaces" : "tabs";
}

/** Monaco 的 getEOL() 字符串 → 状态栏语义。只认 CRLF，其余一律 LF。 */
export function filesEditorEolFromMonaco(eol: string | undefined): FilesEditorEol {
  return eol === "\r\n" ? "CRLF" : "LF";
}

/** 两份快照是否等价。用于避免无意义的重渲染。 */
export function filesEditorStatusEqual(
  left: FilesEditorStatusSnapshot,
  right: FilesEditorStatusSnapshot,
): boolean {
  return (
    left.lineNumber === right.lineNumber &&
    left.column === right.column &&
    left.lineCount === right.lineCount &&
    left.languageId === right.languageId &&
    left.indentKind === right.indentKind &&
    left.tabSize === right.tabSize &&
    left.eol === right.eol
  );
}

/** 诊断计数：只统计错误与警告。 */
export function filesEditorMarkerCounts(markers: readonly FilesEditorStatusMarker[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const marker of markers) {
    if (marker.severity === "error") {
      errors += 1;
    } else if (marker.severity === "warning") {
      warnings += 1;
    }
  }
  return { errors, warnings };
}

/** 诊断列表排序：错误在前，同级按行列升序，保证状态栏列表顺序稳定。 */
export function filesEditorSortMarkers(
  markers: readonly FilesEditorStatusMarker[],
): FilesEditorStatusMarker[] {
  const severityRank: Record<FilesEditorMarkerSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  return [...markers].sort((left, right) => {
    const rank = severityRank[left.severity] - severityRank[right.severity];
    if (rank !== 0) return rank;
    if (left.lineNumber !== right.lineNumber) return left.lineNumber - right.lineNumber;
    if (left.column !== right.column) return left.column - right.column;
    return left.id.localeCompare(right.id);
  });
}

/** 「跳转到行/列」的目标：line 必填；column 省略时按第 1 列处理。 */
export interface FilesEditorGotoTarget {
  line: number;
  column?: number;
}

/**
 * 解析「跳转到行/列」输入的语法，规则对齐 VS Code 的 gotoLineQuickAccess：
 * `12`、`12:5`、`12,5`、`12#5`，允许一个前导冒号（`:12:5`）。数字段按 parseInt
 * 解析（`12abc` 按行 12 接受），列段缺失、为空或非数字时按省略列处理。
 * 这里只做语法解析，不校验范围；越界由句柄按模型实际行列数夹取，
 * 因为列上限依赖行内容（getLineMaxColumn），纯模型层拿不到。
 */
export function filesEditorParseGotoTarget(input: string): FilesEditorGotoTarget | undefined {
  const parts = input.trim().replace(/^:/, "").split(/,|:|#/);
  const line = Number.parseInt(parts[0] ?? "", 10);
  if (Number.isNaN(line)) return undefined;
  const target: FilesEditorGotoTarget = { line };
  const column = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isNaN(column)) target.column = column;
  return target;
}

/**
 * 行号夹取（VS Code 同式）：负数从末尾倒数（-1 = 最后一行），再夹到 [1, lineCount]。
 * `0` 不是合法行号，夹取后落第 1 行。lineCount 为 0 时由调用方先拦下，不进这里。
 */
export function filesEditorClampGotoLineNumber(line: number, lineCount: number): number {
  const resolved = line >= 0 ? line : lineCount + 1 + line;
  return Math.min(Math.max(1, resolved), lineCount);
}

/**
 * 列号夹取（VS Code 同式）：负数从行尾倒数（-1 = 行尾前一列），
 * 再夹到 [1, maxColumn]。maxColumn 取该行的 Monaco 模型列上限
 * （getLineMaxColumn，行尾后一位），与状态栏「列 N」同口径。
 */
export function filesEditorClampGotoColumnNumber(column: number, maxColumn: number): number {
  const resolved = column >= 0 ? column : maxColumn + column;
  return Math.min(Math.max(1, resolved), maxColumn);
}

/**
 * 语言浮层的列表：按流行度降序，命中查询才保留。
 *
 * 流行度来自 `filesEditorLanguagePopularity.ts` 的调研排名表：常用语言在前，
 * 没有份额数据的方言垫底并按 id 升序。查询匹配 id 与别名；扩展名只在查询以
 * `.` 开头时参与匹配：Monaco 给 XML 注册了 `.targets`、给 Kotlin 注册了 `.kts`，
 * 无条件按子串匹配扩展名的话，搜「ts」的结果会被这些只是扩展名沾边的语言刷屏。
 * 方言 id（如 `freemarker2.tag-angle.interpolation-bracket`）仍按 id 子串命中，
 * 用户按「Angle」能搜到；按「.ftl」能按扩展名搜到。
 */
export function filesEditorFilterLanguages(
  languages: readonly FilesEditorStatusLanguage[],
  query: string,
): FilesEditorStatusLanguage[] {
  const keyword = query.trim().toLowerCase();
  const sorted = [...languages].sort(compareFilesEditorLanguagesByPopularity);
  if (!keyword) return sorted;
  const matchByExtension = keyword.startsWith(".");
  return sorted.filter((language) => {
    if (language.id.toLowerCase().includes(keyword)) return true;
    if (language.aliases.some((alias) => alias.toLowerCase().includes(keyword))) return true;
    return (
      matchByExtension &&
      language.extensions.some((extension) => extension.toLowerCase().includes(keyword))
    );
  });
}

/** 流行度优先；没有份额数据的语言同档，按 id 升序，保证顺序稳定。 */
function compareFilesEditorLanguagesByPopularity(
  left: FilesEditorStatusLanguage,
  right: FilesEditorStatusLanguage,
): number {
  return compareFilesEditorLanguageIdsByPopularity(left.id, right.id);
}

/** 语言浮层里那条弱化说明：优先别名，其次文件扩展名，都没有就不显示。 */
export function filesEditorLanguageDescription(
  language: FilesEditorStatusLanguage,
): string | undefined {
  const aliases = language.aliases.filter((alias) => alias !== language.label);
  if (aliases.length > 0) return aliases.join(" · ");
  if (language.extensions.length > 0) return language.extensions.join(" ");
  return undefined;
}
