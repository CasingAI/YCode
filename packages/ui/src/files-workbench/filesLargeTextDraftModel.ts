import { getPathLeaf } from "@/lib/path.js";
import {
  FILES_LARGE_TEXT_BLOCK_STEP,
  filesLargeTextBlockIndex,
} from "@/files-workbench/filesLargeTextBlockModel.js";
import { isFilesLargeTextBuffer } from "@/files-workbench/filesEditorBufferModel.js";
import type {
  FilesBuffer,
  FilesEditorState,
  FilesLargeTextBlockChange,
  FilesLargeTextBlockTarget,
  FilesLargeTextEditHistoryEntry,
  FilesLargeTextEditState,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 大文件固定块草稿的纯函数核心。
 *
 * Files Editor Store 是 `changes`、脏态、全 buffer 撤销 / 重做历史的唯一所有者；
 * 这里只做不可变状态转换，不读盘、不写 IndexedDB、不依赖 React。
 */

function normalizeBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function createFilesLargeTextEditState(
  version: string,
  totalBytes: number,
): FilesLargeTextEditState {
  return {
    baseVersion: version,
    baseTotalBytes: normalizeBytes(totalBytes),
    changes: [],
    undoStack: [],
    redoStack: [],
    revision: 0,
  };
}

export function isFilesLargeTextChangeEffective(change: FilesLargeTextBlockChange): boolean {
  return change.text !== change.originalText;
}

export function hasFilesLargeTextEditChanges(edit: FilesLargeTextEditState | undefined): boolean {
  return edit?.changes.some(isFilesLargeTextChangeEffective) ?? false;
}

export function collectFilesLargeTextPatches(
  edit: FilesLargeTextEditState | undefined,
): Array<{ offset: number; deleteBytes: number; text: string }> {
  return (edit?.changes ?? [])
    .filter(isFilesLargeTextChangeEffective)
    .slice()
    .sort((left, right) => left.offset - right.offset)
    .map((change) => ({
      offset: change.offset,
      deleteBytes: change.deleteBytes,
      text: change.text,
    }));
}

function sortChanges(changes: FilesLargeTextBlockChange[]): FilesLargeTextBlockChange[] {
  return changes.slice().sort((left, right) => left.offset - right.offset);
}

function isBlockTargetValid(block: FilesLargeTextBlockTarget, totalBytes: number): boolean {
  return (
    Number.isSafeInteger(block.blockIndex) &&
    block.blockIndex >= 0 &&
    Number.isSafeInteger(block.offset) &&
    block.offset >= 0 &&
    Number.isSafeInteger(block.deleteBytes) &&
    block.deleteBytes >= 0 &&
    typeof block.originalText === "string" &&
    block.offset + block.deleteBytes <= totalBytes &&
    block.blockIndex === filesLargeTextBlockIndex(block.offset) &&
    block.hasDecodingErrors !== true
  );
}

function toChange(block: FilesLargeTextBlockTarget, text: string): FilesLargeTextBlockChange {
  return {
    blockIndex: block.blockIndex,
    offset: block.offset,
    deleteBytes: block.deleteBytes,
    originalText: block.originalText,
    text,
  };
}

function findChange(
  changes: readonly FilesLargeTextBlockChange[],
  offset: number,
): FilesLargeTextBlockChange | undefined {
  return changes.find((change) => change.offset === offset);
}

function applyHistorySide(
  changes: readonly FilesLargeTextBlockChange[],
  entry: FilesLargeTextEditHistoryEntry,
  side: "before" | "after",
): FilesLargeTextBlockChange[] {
  const text = entry[side];
  const existing = findChange(changes, entry.offset);
  if (text === undefined) {
    return existing ? changes.filter((change) => change.offset !== entry.offset) : [...changes];
  }
  const next: FilesLargeTextBlockChange = {
    blockIndex: entry.blockIndex,
    offset: entry.offset,
    deleteBytes: entry.deleteBytes,
    originalText: entry.originalText,
    text,
  };
  return existing
    ? changes.map((change) => (change.offset === entry.offset ? next : change))
    : sortChanges([...changes, next]);
}

/** 用户编辑当前块：同一 offset 最多一条，任意块内编辑都归入该块。 */
export function updateFilesLargeTextBlockInEdit(
  edit: FilesLargeTextEditState,
  block: FilesLargeTextBlockTarget,
  text: string,
): FilesLargeTextEditState {
  if (!isBlockTargetValid(block, edit.baseTotalBytes)) {
    return edit;
  }
  const existing = findChange(edit.changes, block.offset);
  if (existing && existing.originalText !== block.originalText) {
    // 基准原块已变化（外部改盘 / 旧坐标）；不能把新文本套到旧补丁坐标。
    return edit;
  }
  if (existing && existing.text === text) {
    return edit;
  }
  if (!existing && text === block.originalText) {
    return edit;
  }
  const changes = existing
    ? text === block.originalText
      ? edit.changes.filter((change) => change.offset !== block.offset)
      : edit.changes.map((change) =>
          change.offset === block.offset ? toChange(block, text) : change,
        )
    : sortChanges([...edit.changes, toChange(block, text)]);
  const history: FilesLargeTextEditHistoryEntry = {
    blockIndex: block.blockIndex,
    offset: block.offset,
    deleteBytes: block.deleteBytes,
    originalText: block.originalText,
    ...(existing && existing.text !== block.originalText ? { before: existing.text } : undefined),
    ...(text !== block.originalText ? { after: text } : undefined),
  };
  return {
    ...edit,
    changes,
    undoStack: [...edit.undoStack, history],
    redoStack: [],
    revision: edit.revision + 1,
  };
}

export function undoFilesLargeTextEditState(
  edit: FilesLargeTextEditState,
): FilesLargeTextEditState {
  const entry = edit.undoStack.at(-1);
  if (!entry) return edit;
  return {
    ...edit,
    changes: applyHistorySide(edit.changes, entry, "before"),
    undoStack: edit.undoStack.slice(0, -1),
    redoStack: [...edit.redoStack, entry],
    revision: edit.revision + 1,
  };
}

export function redoFilesLargeTextEditState(
  edit: FilesLargeTextEditState,
): FilesLargeTextEditState {
  const entry = edit.redoStack.at(-1);
  if (!entry) return edit;
  return {
    ...edit,
    changes: applyHistorySide(edit.changes, entry, "after"),
    undoStack: [...edit.undoStack, entry],
    redoStack: edit.redoStack.slice(0, -1),
    revision: edit.revision + 1,
  };
}

/** 用户放弃修改：只清草稿与历史，基准版本保持不变。 */
export function discardFilesLargeTextEditState(
  edit: FilesLargeTextEditState,
): FilesLargeTextEditState {
  if (edit.changes.length === 0 && edit.undoStack.length === 0 && edit.redoStack.length === 0) {
    return edit;
  }
  return {
    ...edit,
    changes: [],
    undoStack: [],
    redoStack: [],
    revision: edit.revision + 1,
  };
}

/** 保存成功：以提交结果重建基准，清空修改与历史。 */
export function markFilesLargeTextEditSaved(
  edit: FilesLargeTextEditState,
  version: string,
  totalBytes: number,
): FilesLargeTextEditState {
  return {
    ...edit,
    baseVersion: version,
    baseTotalBytes: normalizeBytes(totalBytes),
    changes: [],
    undoStack: [],
    redoStack: [],
    revision: edit.revision + 1,
  };
}

function sanitizeRestoredChanges(
  changes: readonly FilesLargeTextBlockChange[],
  totalBytes: number,
): FilesLargeTextBlockChange[] {
  const byOffset = new Map<number, FilesLargeTextBlockChange>();
  for (const change of changes) {
    if (
      !Number.isSafeInteger(change.blockIndex) ||
      change.blockIndex < 0 ||
      !Number.isSafeInteger(change.offset) ||
      change.offset < 0 ||
      !Number.isSafeInteger(change.deleteBytes) ||
      change.deleteBytes < 0 ||
      typeof change.originalText !== "string" ||
      typeof change.text !== "string" ||
      change.offset + change.deleteBytes > totalBytes ||
      change.blockIndex !== filesLargeTextBlockIndex(change.offset) ||
      !isFilesLargeTextChangeEffective(change)
    ) {
      continue;
    }
    byOffset.set(change.offset, change);
  }
  return sortChanges([...byOffset.values()]);
}

export function replaceFilesBufferInState(
  state: FilesEditorState,
  id: string,
  update: (buffer: FilesBuffer) => FilesBuffer | undefined,
): FilesEditorState {
  let changed = false;
  const buffers = state.buffers.flatMap((buffer) => {
    if (buffer.id !== id) return [buffer];
    const next = update(buffer);
    if (!next || next === buffer) return [buffer];
    changed = true;
    return [next];
  });
  return changed ? { ...state, buffers } : state;
}

export interface FilesLargeTextRestoreParams {
  baseVersion: string;
  baseTotalBytes: number;
  changes: readonly FilesLargeTextBlockChange[];
}

/**
 * 初始化编辑基准。幂等：相同基准不重置；脏草稿遇到不同基准时保持原样，
 * 绝不静默把补丁 rebase 到新版本。
 */
export function initializeLargeTextEditInState(
  state: FilesEditorState,
  id: string,
  version: string,
  totalBytes: number,
): FilesEditorState {
  if (typeof version !== "string" || version.length === 0) return state;
  return replaceFilesBufferInState(state, id, (buffer) => {
    if (!isFilesLargeTextBuffer(buffer) || buffer.saveToken) return buffer;
    const current = buffer.edit;
    const total = normalizeBytes(totalBytes);
    if (current && current.baseVersion === version && current.baseTotalBytes === total) {
      return buffer;
    }
    if (current && hasFilesLargeTextEditChanges(current)) {
      return buffer;
    }
    return {
      ...buffer,
      edit: {
        ...createFilesLargeTextEditState(version, total),
        revision: (current?.revision ?? 0) + 1,
      },
      externalChange: undefined,
    };
  });
}

/** IndexedDB 草稿恢复：只有无草稿或基准完全一致时才套用。 */
export function restoreLargeTextEditInState(
  state: FilesEditorState,
  id: string,
  params: FilesLargeTextRestoreParams,
): FilesEditorState {
  if (typeof params.baseVersion !== "string" || params.baseVersion.length === 0) return state;
  return replaceFilesBufferInState(state, id, (buffer) => {
    if (!isFilesLargeTextBuffer(buffer) || buffer.saveToken) return buffer;
    const total = normalizeBytes(params.baseTotalBytes);
    const current = buffer.edit;
    if (current && current.baseVersion !== params.baseVersion) {
      return buffer;
    }
    const changes = sanitizeRestoredChanges(params.changes, total);
    const next: FilesLargeTextEditState = {
      baseVersion: params.baseVersion,
      baseTotalBytes: total,
      changes,
      undoStack: [],
      redoStack: [],
      revision: (current?.revision ?? 0) + 1,
    };
    return { ...buffer, edit: next, externalChange: undefined };
  });
}

export function updateFilesLargeTextBlockInState(
  state: FilesEditorState,
  id: string,
  block: FilesLargeTextBlockTarget,
  text: string,
): FilesEditorState {
  return replaceFilesBufferInState(state, id, (buffer) => {
    if (!isFilesLargeTextBuffer(buffer) || !buffer.edit || buffer.saveToken) return buffer;
    const edit = updateFilesLargeTextBlockInEdit(buffer.edit, block, text);
    return edit === buffer.edit ? buffer : { ...buffer, edit };
  });
}

export function undoFilesLargeTextEditInState(
  state: FilesEditorState,
  id: string,
): FilesEditorState {
  return replaceFilesBufferInState(state, id, (buffer) => {
    if (!isFilesLargeTextBuffer(buffer) || !buffer.edit || buffer.saveToken) return buffer;
    const edit = undoFilesLargeTextEditState(buffer.edit);
    return edit === buffer.edit ? buffer : { ...buffer, edit };
  });
}

export function redoFilesLargeTextEditInState(
  state: FilesEditorState,
  id: string,
): FilesEditorState {
  return replaceFilesBufferInState(state, id, (buffer) => {
    if (!isFilesLargeTextBuffer(buffer) || !buffer.edit || buffer.saveToken) return buffer;
    const edit = redoFilesLargeTextEditState(buffer.edit);
    return edit === buffer.edit ? buffer : { ...buffer, edit };
  });
}

export function discardFilesLargeTextEditsInState(
  state: FilesEditorState,
  id: string,
): FilesEditorState {
  return replaceFilesBufferInState(state, id, (buffer) => {
    if (!isFilesLargeTextBuffer(buffer) || !buffer.edit || buffer.saveToken) return buffer;
    const edit = discardFilesLargeTextEditState(buffer.edit);
    return edit === buffer.edit ? buffer : { ...buffer, edit, externalChange: undefined };
  });
}

/**
 * 大文件保存成功。缓冲 ID 保持稳定，只更新路径 / 标题与基准；
 * 后续块坐标立即按新版本重新计算。
 */
export function markLargeTextSavedInState(
  state: FilesEditorState,
  id: string,
  params: { path?: string; version: string; totalBytes: number },
): FilesEditorState {
  if (typeof params.version !== "string" || params.version.length === 0) return state;
  return replaceFilesBufferInState(state, id, (buffer) => {
    if (!isFilesLargeTextBuffer(buffer)) return buffer;
    const path = params.path && params.path.length > 0 ? params.path : buffer.path;
    const edit = markFilesLargeTextEditSaved(
      buffer.edit ?? createFilesLargeTextEditState(params.version, params.totalBytes),
      params.version,
      params.totalBytes,
    );
    return {
      ...buffer,
      path,
      title: path === buffer.path ? buffer.title : getPathLeaf(path),
      edit,
      externalChange: undefined,
    };
  });
}

/** 供 UI / save agent 读取当前补丁，不暴露内部数组。 */
export function filesLargeTextEditPatches(
  buffer: FilesBuffer,
): Array<{ offset: number; deleteBytes: number; text: string }> {
  return isFilesLargeTextBuffer(buffer) ? collectFilesLargeTextPatches(buffer.edit) : [];
}

export { FILES_LARGE_TEXT_BLOCK_STEP };
