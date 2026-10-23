/**
 * 文件工作台 → 桌面菜单上下文的投影计算。
 *
 * 菜单只需要「有没有可关的标签 / 能不能保存 / 有几个脏文件」这类布尔量与计数，
 * 不需要文件正文。本模块是纯函数，方便单测覆盖。
 *
 * 投影只含标量：菜单上下文每次变化都要跨进程同步一遍，
 * 正文级别的状态（哪怕只是数组引用变化）不能进投影，否则每次击键都会同步一次。
 */
import type { DesktopMenuEditorState } from "@zcode/shared";
import { isFilesBufferDirty, isFilesTextBuffer } from "@/files-workbench/filesEditorModel.js";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 计算当前激活编辑器的菜单状态。
 *
 * - hasActiveEditor：当前有活动标签（哪怕是图片预览也算「有编辑器」）；
 * - canSave：活动标签是已加载的可写文本文件（图片等只读预览不可保存；
 *   未命名文件同样可保存——保存动作会转入另存为对话框，不是不可用）；
 * - dirtyFileCount：所有打开标签里未保存的文本文件数量（全部保存条目据此置灰）。
 */
export function resolveFilesEditorMenuState(state: {
  buffers: readonly FilesBuffer[];
  openIds: readonly string[];
  activeId?: string | null;
}): DesktopMenuEditorState {
  const buffersById = new Map(state.buffers.map((buffer) => [buffer.id, buffer]));
  const activeBuffer = state.activeId ? buffersById.get(state.activeId) : undefined;
  const dirtyFileCount = state.openIds.reduce((count, id) => {
    const buffer = buffersById.get(id);
    return buffer && isFilesBufferDirty(buffer) ? count + 1 : count;
  }, 0);

  return {
    hasActiveEditor: Boolean(activeBuffer),
    // 恢复中的正文尚未读盘，不能把占位空文本另存为真实文件。
    canSave: Boolean(
      activeBuffer && isFilesTextBuffer(activeBuffer) && activeBuffer.loadState === undefined,
    ),
    dirtyFileCount,
  };
}
