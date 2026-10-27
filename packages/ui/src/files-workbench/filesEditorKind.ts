import { resolveFilePreviewKind } from "@/lib/filePreviewKind.js";
import type { FilesBufferKind } from "@/files-workbench/filesEditorTypes.js";

export function resolveFilesBufferKind(path: string): FilesBufferKind {
  // 文本候选仍走 readTextFile，由 isBinary 结果决定是否转成只读预览；
  // 已知的非文本类型直接建只读预览缓冲，避免工作台再维护一套格式名单。
  return resolveFilePreviewKind(path) === "text" ? "text" : "preview";
}
