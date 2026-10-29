import {
  isFilesBufferDirty,
  isFilesLargeTextBuffer,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import type {
  FilesEditorState,
  FilesLargeTextBuffer,
  FilesPreviewBuffer,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 原位置把文本缓冲改为只读预览，保持 ID、布局与焦点不变。
 * 草稿优先：脏文本、未命名或无路径缓冲不转换。
 */
export function convertTextBufferToPreviewInState(
  state: FilesEditorState,
  id: string,
  params?: { allowDirty?: boolean },
): FilesEditorState {
  const index = state.buffers.findIndex((buffer) => buffer.id === id);
  if (index < 0) return state;
  const buffer = state.buffers[index]!;
  // 文本缓冲与只读大文本缓冲都能在原 ID 内转为预览；后者没有正文可丢失。
  if (!isFilesTextBuffer(buffer) && !isFilesLargeTextBuffer(buffer)) {
    return state;
  }
  if (!buffer.path) {
    return state;
  }
  if (isFilesTextBuffer(buffer) && buffer.untitled) {
    return state;
  }
  // 草稿优先：常规分类修正不覆盖脏正文；冲突里用户明确选择「使用磁盘」才允许丢弃。
  if (isFilesTextBuffer(buffer) && !params?.allowDirty && isFilesBufferDirty(buffer)) {
    return state;
  }
  const preview: FilesPreviewBuffer = {
    id: buffer.id,
    kind: "preview",
    path: buffer.path,
    title: buffer.title,
    workspace: buffer.workspace,
    preview: buffer.preview === true ? true : undefined,
  };
  const buffers = [...state.buffers];
  buffers[index] = preview;
  return { ...state, buffers };
}

/**
 * 原位置把文本缓冲改为只读大文本缓冲，保持 ID、标签顺序、分屏与焦点不变。
 *
 * 常规打开/恢复按读取决策转换时保留脏草稿（草稿优先）；
 * 保存冲突里用户明确选择「使用磁盘」时传 allowDirty，丢弃的可编辑基准交给大文本窗口。
 */
export function convertTextBufferToLargeTextInState(
  state: FilesEditorState,
  id: string,
  params?: { totalBytes?: number; readonlyReason?: "encoding"; allowDirty?: boolean },
): FilesEditorState {
  const index = state.buffers.findIndex((buffer) => buffer.id === id);
  if (index < 0) return state;
  const buffer = state.buffers[index]!;
  if (!isFilesTextBuffer(buffer) || !buffer.path || buffer.untitled) {
    return state;
  }
  if (!params?.allowDirty && isFilesBufferDirty(buffer)) {
    return state;
  }
  const large: FilesLargeTextBuffer = {
    id: buffer.id,
    kind: "large-text",
    path: buffer.path,
    title: buffer.title,
    workspace: buffer.workspace,
    preview: buffer.preview === true ? true : undefined,
    totalBytes: params?.totalBytes,
    readonlyReason: params?.readonlyReason,
  };
  const buffers = [...state.buffers];
  buffers[index] = large;
  return { ...state, buffers };
}
