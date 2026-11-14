import { filesWorkspaceKey, isFilesBufferDirty } from "@/files-workbench/filesEditorModel.js";
import {
  captureFilesTextSnapshot,
  filesTextBufferDocumentVersionId,
} from "@/files-workbench/filesTextDocumentModel.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

export type FilesCloseAfterSaveDecision = "close" | "prompt" | "gone";

export interface FilesCloseSnapshot {
  bufferRef: FilesBuffer;
  id: string;
  kind: FilesBuffer["kind"];
  path?: string;
  workspaceKey: string;
  text?: string;
  savedText?: string;
  diskVersion?: string;
  /** 绑定模型的替代版本号；文本缓冲用它发现缓冲 text 未跟上的新输入。 */
  documentVersionId?: number;
  revision?: number;
  baseVersion?: string;
  baseTotalBytes?: number;
}

/**
 * 在关闭等待开始前取原子快照。文本缓冲必须同时记录正文和文档版本号：
 * 输入期间 buffer.text 可能落后于 Monaco 模型，只有版本号能发现新输入。
 */
export function captureFilesCloseSnapshot(buffer: FilesBuffer): FilesCloseSnapshot {
  const textSnapshot = buffer.kind === "text" ? captureFilesTextSnapshot(buffer) : undefined;
  return {
    bufferRef: buffer,
    id: buffer.id,
    path: buffer.path,
    kind: buffer.kind,
    text: textSnapshot?.text,
    savedText: buffer.kind === "text" ? buffer.savedText : undefined,
    diskVersion: buffer.kind === "text" ? buffer.diskVersion : undefined,
    documentVersionId: textSnapshot?.documentVersionId,
    revision: buffer.kind === "large-text" ? buffer.edit?.revision : undefined,
    baseVersion: buffer.kind === "large-text" ? buffer.edit?.baseVersion : undefined,
    baseTotalBytes: buffer.kind === "large-text" ? buffer.edit?.baseTotalBytes : undefined,
    workspaceKey: filesWorkspaceKey(buffer.workspace),
  };
}

export type FilesCloseAfterDiscardDecision = "close" | "prompt" | "gone";

/**
 * 保存返回成功后关闭流程必须重新检查缓冲：保存 await 期间的新输入会让缓冲再次变脏。
 * 此时不能静默关闭，应重新提示用户；缓冲已被其它流程关闭则直接结束。
 */
export function resolveFilesCloseAfterSave(
  buffers: readonly FilesBuffer[],
  bufferId: string,
): FilesCloseAfterSaveDecision {
  const buffer = buffers.find((candidate) => candidate.id === bufferId);
  if (!buffer) return "gone";
  return isFilesBufferDirty(buffer) ? "prompt" : "close";
}

/**
 * 草稿存储的异步等待结束后，只有原 buffer 仍持有同一快照才允许关闭。
 * 等待期间输入、身份或保存代次变化时重新提示，不得关闭或丢弃新草稿。
 */
export function resolveFilesCloseAfterDiscard(
  buffers: readonly FilesBuffer[],
  snapshot: FilesCloseSnapshot,
): FilesCloseAfterDiscardDecision {
  const buffer = buffers.find((candidate) => candidate.id === snapshot.id);
  if (!buffer) return "gone";
  if (buffer !== snapshot.bufferRef) return "prompt";
  if (
    buffer.kind !== snapshot.kind ||
    buffer.path !== snapshot.path ||
    filesWorkspaceKey(buffer.workspace) !== snapshot.workspaceKey ||
    (buffer.kind === "large-text" &&
      (buffer.saveToken ||
        buffer.edit?.revision !== snapshot.revision ||
        buffer.edit?.baseVersion !== snapshot.baseVersion ||
        buffer.edit?.baseTotalBytes !== snapshot.baseTotalBytes)) ||
    (buffer.kind === "text" &&
      ((snapshot.documentVersionId === undefined
        ? buffer.text !== snapshot.text
        : filesTextBufferDocumentVersionId(buffer) !== snapshot.documentVersionId) ||
        buffer.savedText !== snapshot.savedText ||
        buffer.diskVersion !== snapshot.diskVersion))
  ) {
    return "prompt";
  }
  return "close";
}
