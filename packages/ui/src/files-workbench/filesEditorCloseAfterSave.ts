import { filesWorkspaceKey, isFilesBufferDirty } from "@/files-workbench/filesEditorModel.js";
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
  revision?: number;
  baseVersion?: string;
  baseTotalBytes?: number;
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
      (buffer.text !== snapshot.text ||
        buffer.savedText !== snapshot.savedText ||
        buffer.diskVersion !== snapshot.diskVersion))
  ) {
    return "prompt";
  }
  return "close";
}
