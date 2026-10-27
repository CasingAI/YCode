import { isFilesBufferDirty, isFilesTextBuffer } from "@/files-workbench/filesEditorModel.js";
import type { FilesEditorState, FilesPreviewBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 原位置把文本缓冲改为只读预览，保持 ID、布局与焦点不变。
 * 草稿优先：脏文本、未命名或无路径缓冲不转换。
 */
export function convertTextBufferToPreviewInState(
  state: FilesEditorState,
  id: string,
): FilesEditorState {
  const index = state.buffers.findIndex((buffer) => buffer.id === id);
  if (index < 0) return state;
  const buffer = state.buffers[index]!;
  if (!isFilesTextBuffer(buffer) || !buffer.path || buffer.untitled || isFilesBufferDirty(buffer)) {
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
