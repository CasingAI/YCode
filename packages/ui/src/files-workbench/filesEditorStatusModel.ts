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

/** 跳转到行：行号非法时返回 undefined，由调用方决定不动作。 */
export function filesEditorResolveGotoLine(input: string, lineCount: number): number | undefined {
  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  if (lineCount > 0 && parsed > lineCount) return undefined;
  return parsed;
}

/**
 * 语言浮层的列表：按流行度降序，命中查询才保留。
 *
 * 流行度来自 `filesEditorLanguagePopularity.ts` 的调研排名表：常用语言在前，
 * 没有份额数据的方言垫底并按 id 升序。查询同时匹配 id、别名与扩展名：
 * Monaco 注册的语言里有一批 `freemarker2.tag-angle.interpolation-bracket`
 * 这类方言 id，只按 id 匹配的话，用户按「Angle」或「.ftl」都搜不到。
 */
export function filesEditorFilterLanguages(
  languages: readonly FilesEditorStatusLanguage[],
  query: string,
): FilesEditorStatusLanguage[] {
  const keyword = query.trim().toLowerCase();
  const sorted = [...languages].sort(compareFilesEditorLanguagesByPopularity);
  if (!keyword) return sorted;
  return sorted.filter((language) => {
    if (language.id.toLowerCase().includes(keyword)) return true;
    if (language.aliases.some((alias) => alias.toLowerCase().includes(keyword))) return true;
    return language.extensions.some((extension) => extension.toLowerCase().includes(keyword));
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
