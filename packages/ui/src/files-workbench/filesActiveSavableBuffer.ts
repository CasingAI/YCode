import { canSaveFilesBuffer } from "@/files-workbench/filesEditorModel.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 当前可保存的活动缓冲：加载完成的完整文本，或存在有效块修改的大文件。
 * 图片预览和尚未读盘的恢复文本不参与保存 / 另存为。
 */
export function filesActiveSavableBuffer(
  buffers: readonly FilesBuffer[],
  activeId?: string,
): FilesBuffer | undefined {
  const buffer = buffers.find((candidate) => candidate.id === activeId);
  return buffer && canSaveFilesBuffer(buffer) ? buffer : undefined;
}
