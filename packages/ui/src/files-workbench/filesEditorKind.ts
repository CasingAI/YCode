import { resolveFilePreviewKind } from "@/lib/filePreviewKind.js";
import type { FilesBufferKind } from "@/files-workbench/filesEditorTypes.js";

export function resolveFilesBufferKind(path: string): FilesBufferKind {
  // 文本候选由统一读取决策的 isBinary / 大小结果决定可编辑、只读大文本或预览；
  // 已知的非文本类型直接建只读预览缓冲，避免工作台再维护一套格式名单。
  return resolveFilePreviewKind(path) === "text" ? "text" : "preview";
}
