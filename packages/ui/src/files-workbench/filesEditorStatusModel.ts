/**
 * 文件工作台状态栏的纯模型层。
 *
 * 这里只放结构化数据与纯函数：不引入 React，也不引入 Monaco 类型，
 * 方便单测直接覆盖（见 packages/ui/test/filesEditorStatusBar.test.ts）。
 * 规格见 docs/specs/files-editor-status-bar.md。
 */

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
