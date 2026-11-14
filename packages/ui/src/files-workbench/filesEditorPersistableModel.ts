import { snapshotFilesTextBuffer } from "@/files-workbench/filesTextDocumentModel.js";
import {
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import type {
  FilesEditorState,
  FilesPersistedDraft,
  FilesPersistedOpenTab,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 会话持久化投影：只包含脏草稿与打开的标签元数据。
 *
 * 正文来自显式快照（绑定文档时为模型当前正文），这是持久化边界；
 * 逐键路径不会走到这里。放在独立模块，避免 Store 模型文件继续膨胀。
 */
export function persistableDrafts(state: FilesEditorState): FilesPersistedDraft[] {
  const seen = new Set<string>();
  return state.buffers.flatMap((buffer) => {
    if (!isFilesTextBuffer(buffer) || !isFilesBufferDirty(buffer) || seen.has(buffer.id)) {
      return [];
    }
    seen.add(buffer.id);
    return [
      {
        id: buffer.id,
        path: buffer.path,
        title: buffer.title,
        text: snapshotFilesTextBuffer(buffer),
        savedText: buffer.savedText,
        workspace: buffer.workspace,
        untitled: buffer.untitled,
        truncated: buffer.truncated === true ? true : undefined,
      },
    ];
  });
}

export function persistableOpenTabs(state: FilesEditorState): FilesPersistedOpenTab[] {
  const seen = new Set<string>();
  return state.openIds.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const buffer = findFilesBuffer(state, id);
    if (!buffer) {
      return [];
    }
    if (isFilesTextBuffer(buffer) && buffer.untitled && !isFilesBufferDirty(buffer)) {
      return [];
    }
    return [
      {
        id: buffer.id,
        kind: buffer.kind,
        path: buffer.path,
        workspace: buffer.workspace,
        untitled: isFilesTextBuffer(buffer) ? buffer.untitled : undefined,
        preview: buffer.preview === true ? true : undefined,
      },
    ];
  });
}
