import {
  findFilesEditorGroupsForBuffer,
  replaceFilesEditorViewBuffer,
} from "@/files-workbench/filesEditorLayout.js";
import { removeFilesEditorViewsForBuffer } from "@/files-workbench/filesEditorLayoutOperations.js";
import { addBufferToFocusedGroup } from "@/files-workbench/filesEditorStoreLayout.js";
import {
  closeBufferInState,
  filesWorkspaceKey,
  findFilesBuffer,
  openBufferInState,
  updateTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import {
  activeFilesTextDocument,
  rememberFilesTextDocumentSavedVersion,
  snapshotFilesTextBuffer,
} from "@/files-workbench/filesTextDocumentModel.js";
import type { FilesEditorLayoutState } from "@/files-workbench/filesEditorLayout.js";
import type {
  FilesBuffer,
  FilesEditorState,
  FilesTextBuffer,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";

export interface FilesBufferSavedParams {
  path: string;
  text: string;
  workspace: FilesWorkspaceRef;
  preserveCurrentText?: boolean;
  version?: string;
  documentVersionId?: number;
}

type FilesSavedState = FilesEditorState & { layout: FilesEditorLayoutState };

/**
 * 保存完成时解析要落库的正文与版本基线。
 *
 * 提交时版本号已给出、绑定仍有效且缓冲 ID 不变时，正文权威就在模型里，
 * 不再为保存完成复制全文。另存为会重建缓冲 ID，必须快照模型，保住
 * 提交 await 期间的新输入。
 */
export function resolveFilesBufferSaved(
  state: FilesEditorState,
  id: string,
  params: FilesBufferSavedParams,
):
  | { source: FilesTextBuffer; currentText: string; savedDocumentVersionId?: number | null }
  | undefined {
  const source = findFilesBuffer(state, id);
  if (!source || source.kind !== "text") return undefined;
  const document = activeFilesTextDocument(source);
  const keepsBufferId = id === `file:${filesWorkspaceKey(params.workspace)}:${params.path}`;
  const canSkipSnapshot =
    params.documentVersionId !== undefined && document !== undefined && keepsBufferId;
  const currentText =
    params.preserveCurrentText && !canSkipSnapshot ? snapshotFilesTextBuffer(source) : params.text;
  // 保存成功后写回磁盘基准时，正文以调用时刻的模型为准；保存 await 期间的
  // 新输入不会被清掉，但基准只记到提交时捕获的版本号。
  if (!params.preserveCurrentText) document?.replaceText(params.text);
  const savedDocumentVersionId = document
    ? params.documentVersionId !== undefined
      ? params.documentVersionId
      : params.preserveCurrentText
        ? currentText === params.text
          ? document.getVersionId()
          : null
        : document.getVersionId()
    : undefined;
  if (document && savedDocumentVersionId !== undefined) {
    rememberFilesTextDocumentSavedVersion(document, savedDocumentVersionId);
  }
  return { source, currentText, savedDocumentVersionId };
}

/**
 * 保存完成后的状态迁移。
 *
 * 同路径只更新正文 / 基准 / 版本；另存为或改名会重建目标 ID 的缓冲，
 * 但绝不携带旧运行时文档绑定（新 ID 会使用新 model）。
 */
export function applyFilesBufferSaved(
  state: FilesSavedState,
  id: string,
  params: FilesBufferSavedParams,
  currentText: string,
  savedDocumentVersionId: number | null | undefined,
): FilesSavedState {
  const nextId = `file:${filesWorkspaceKey(params.workspace)}:${params.path}`;
  const title = params.path.split(/[\\/]/).filter(Boolean).at(-1) ?? params.path;
  const text = params.preserveCurrentText ? currentText : params.text;
  const documentPatch =
    savedDocumentVersionId === undefined
      ? { document: undefined, savedDocumentVersionId: undefined }
      : { savedDocumentVersionId };
  if (id === nextId) {
    const updated = updateTextBuffer(state, id, {
      text,
      savedText: params.text,
      path: params.path,
      untitled: false,
      title,
      externalChange: undefined,
      ...documentPatch,
      ...(params.version === undefined ? undefined : { diskVersion: params.version }),
    });
    // updateTextBuffer 只返回业务字段；布局属于 Store 状态，必须原样保留。
    return updated === state ? state : { ...updated, layout: state.layout };
  }
  const closed = closeBufferInState(state, id);
  const savedBuffer: FilesBuffer = {
    id: nextId,
    kind: "text",
    untitled: false,
    path: params.path,
    title,
    text,
    savedText: params.text,
    workspace: params.workspace,
    diskVersion: params.version,
  };
  const next = openBufferInState(closed, savedBuffer);
  const targetAlreadyVisible = findFilesEditorGroupsForBuffer(state.layout, nextId).length > 0;
  let layout = targetAlreadyVisible
    ? removeFilesEditorViewsForBuffer(state.layout, id)
    : state.layout;
  if (!targetAlreadyVisible) {
    const oldViews = Object.values(layout.groups).flatMap((group) =>
      group.views.filter((view) => view.bufferId === id).map((view) => view.id),
    );
    for (const viewId of oldViews) {
      layout = replaceFilesEditorViewBuffer(layout, viewId, nextId);
    }
  }
  layout = addBufferToFocusedGroup(layout, nextId);
  return { ...next, layout, activeId: nextId };
}
