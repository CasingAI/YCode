import type {
  FilesEditorMarkdownViewMode,
  FilesEditorView,
} from "@/files-workbench/filesEditorLayout.js";
import { isFilesTextBuffer } from "@/files-workbench/filesEditorBufferModel.js";
import {
  filesEditorFirstLine,
  resolveFilesEditorLanguage,
} from "@/files-workbench/filesEditorLanguage.js";
import type { FilesBuffer, FilesTextBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 工作台 Markdown 预览的可用性判定（纯派生，不缓存、不读盘）。
 *
 * 只对「已加载、有路径、非未命名、非旧版截断的普通文本」且语言解析为
 * `markdown` 的缓冲提供源码 / 预览切换；语言规则与 Monaco 完全共用
 * `resolveFilesEditorLanguage`，因此 `md` / `markdown` / `mdx`、README 与
 * 用户文件关联自动保持一致。大文本、图片等非 text 缓冲永远不适用。
 */
export function isFilesEditorMarkdownPreviewAvailable(
  buffer: FilesBuffer | undefined,
  associations?: Readonly<Record<string, string>>,
): buffer is FilesTextBuffer {
  if (!buffer || !isFilesTextBuffer(buffer)) return false;
  if (!buffer.path || buffer.untitled || buffer.truncated) return false;
  // `loadState` 存在表示恢复标签尚未读盘 / 正在读取 / 读取失败；此时没有完整正文。
  if (buffer.loadState !== undefined) return false;
  return (
    resolveFilesEditorLanguage({
      path: buffer.path,
      firstLine: filesEditorFirstLine(buffer.text),
      associations,
    }).languageId === "markdown"
  );
}

/**
 * 当前 view 应展示的 Markdown 模式；`undefined` 表示不显示切换（按源码处理）。
 * 残留的预览模式在缓冲不再适用时被忽略。
 */
export function resolveFilesEditorMarkdownViewMode(
  view: Pick<FilesEditorView, "markdownViewMode">,
  buffer: FilesBuffer | undefined,
  associations?: Readonly<Record<string, string>>,
): FilesEditorMarkdownViewMode | undefined {
  if (!isFilesEditorMarkdownPreviewAvailable(buffer, associations)) return undefined;
  return view.markdownViewMode === "preview" ? "preview" : "source";
}
