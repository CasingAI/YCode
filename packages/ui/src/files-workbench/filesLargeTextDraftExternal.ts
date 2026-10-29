import { replaceFilesBufferInState } from "@/files-workbench/filesLargeTextDraftModel.js";
import { isFilesLargeTextBuffer } from "@/files-workbench/filesEditorBufferModel.js";
import type { FilesEditorState, FilesExternalChange } from "@/files-workbench/filesEditorTypes.js";

/**
 * 外部修改 / 删除提示的纯函数 reducers。
 *
 * 提示只用于 UI，不替换正文、不重置大文件基准；脏草稿必须由用户明确决定
 * 冲突处理。单独成文件是为了让主草稿模型保持在 max-lines 以内。
 */

const EXTERNAL_CHANGE_KINDS: ReadonlySet<string> = new Set(["changed", "deleted"]);

export function normalizeFilesExternalChange(
  change: FilesExternalChange | undefined,
): FilesExternalChange | undefined {
  if (!change || !EXTERNAL_CHANGE_KINDS.has(change.kind)) return undefined;
  return {
    kind: change.kind,
    ...(change.observedVersion === undefined
      ? undefined
      : { observedVersion: change.observedVersion }),
  };
}

export function setLargeTextExternalChangeInState(
  state: FilesEditorState,
  id: string,
  change: FilesExternalChange | undefined,
): FilesEditorState {
  const normalized = normalizeFilesExternalChange(change);
  return replaceFilesBufferInState(state, id, (buffer) => {
    if (!isFilesLargeTextBuffer(buffer)) return buffer;
    if (
      buffer.externalChange?.kind === normalized?.kind &&
      buffer.externalChange?.observedVersion === normalized?.observedVersion
    ) {
      return buffer;
    }
    return { ...buffer, externalChange: normalized };
  });
}

/** 普通文本的外部变化提示；正文与基准保持不变。 */
export function setTextExternalChangeInState(
  state: FilesEditorState,
  id: string,
  change: FilesExternalChange | undefined,
): FilesEditorState {
  const normalized = normalizeFilesExternalChange(change);
  return replaceFilesBufferInState(state, id, (buffer) => {
    if (buffer.kind !== "text" || buffer.id !== id) return buffer;
    if (
      buffer.externalChange?.kind === normalized?.kind &&
      buffer.externalChange?.observedVersion === normalized?.observedVersion
    ) {
      return buffer;
    }
    return { ...buffer, externalChange: normalized };
  });
}
