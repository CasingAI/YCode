import type * as Monaco from "monaco-editor";
import { filesMonacoLanguageFromPath } from "@/files-workbench/filesMonacoLanguage.js";
import { filesMonacoVirtualFileUri } from "@/files-workbench/filesMonacoTypescriptPath.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

const models = new Map<string, Monaco.editor.ITextModel>();

/**
 * 用户显式选定的语言，按 model uri 记录。
 *
 * 依据：模型被复用时（切标签页、内容重灌、重新解析）会再次套用推断出的语言，
 * 若没有这层记录，用户在状态栏手动改过的语言会被下一次推断覆盖回去。
 */
const explicitLanguages = new Map<string, string>();

/** 程序化 setValue 期间为真。内容变更回调必须跳过，否则规范化差异会来回写缓冲。 */
let writingFilesMonacoModel = 0;

export interface FilesMonacoModelLike {
  getValue(): string;
  setValue(value: string): void;
}

export function isWritingFilesMonacoModel(): boolean {
  return writingFilesMonacoModel > 0;
}

/** 记录「用户显式选定」的语言；此后推断结果不再覆盖该模型。 */
export function setFilesMonacoModelExplicitLanguage(
  model: Monaco.editor.ITextModel,
  languageId: string,
): void {
  explicitLanguages.set(model.uri.toString(), languageId);
}

export function getFilesMonacoModelExplicitLanguage(
  model: Monaco.editor.ITextModel,
): string | undefined {
  return explicitLanguages.get(model.uri.toString());
}

export function clearFilesMonacoModelExplicitLanguage(model: Monaco.editor.ITextModel): void {
  explicitLanguages.delete(model.uri.toString());
}

/**
 * 把缓冲正文灌进编辑器模型。setValue 是同步的，期间抬高 writing 计数，
 * 让 onDidChangeModelContent 能分辨「程序化灌入」和「用户输入」。
 * 依据：生产包 React #185，文件工作台在缓冲与模型之间来回 setState。
 */
export function writeFilesMonacoModelValue(model: FilesMonacoModelLike, value: string): void {
  if (model.getValue() === value) {
    return;
  }
  writingFilesMonacoModel += 1;
  try {
    model.setValue(value);
  } finally {
    writingFilesMonacoModel -= 1;
  }
}

export function getOrCreateFilesMonacoModel(
  monaco: typeof Monaco,
  id: string,
  value: string,
  path?: string,
  workspace?: FilesWorkspaceRef,
  languageId?: string,
): Monaco.editor.ITextModel {
  const uri =
    path && workspace
      ? filesMonacoVirtualFileUri(monaco, workspace, path)
      : `inmemory://files/${encodeURIComponent(id)}`;
  // 语言由调用方解析后传入；未传时退回按路径推断，保证旧调用点仍可用。
  const resolvedLanguage = languageId ?? filesMonacoLanguageFromPath(path);
  const existing = models.get(id);
  if (existing && !existing.isDisposed()) {
    if (existing.uri.toString() === uri) {
      applyFilesMonacoModelLanguage(monaco, existing, resolvedLanguage);
      return existing;
    }
    models.delete(id);
    disposeModelIfUnreferenced(existing);
  } else if (existing) {
    models.delete(id);
  }

  const modelUri = monaco.Uri.parse(uri);
  // Another editor may already have registered this canonical URI under a
  // different buffer ID (for example, an older session with a non-canonical
  // path ID). Monaco rejects a second model for the same URI; reuse the model
  // rather than leaving the newly opened tab with an empty editor.
  const existingByUri = monaco.editor.getModel(modelUri);
  if (existingByUri && !existingByUri.isDisposed()) {
    models.set(id, existingByUri);
    applyFilesMonacoModelLanguage(monaco, existingByUri, resolvedLanguage);
    return existingByUri;
  }

  const model = monaco.editor.createModel(value, resolvedLanguage, modelUri);
  models.set(id, model);
  return model;
}

/**
 * 套用解析出的语言。用户显式选定过的模型保持原样，不被推断结果覆盖。
 */
function applyFilesMonacoModelLanguage(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  languageId: string,
): void {
  if (getFilesMonacoModelExplicitLanguage(model)) return;
  if (model.getLanguageId() === languageId) return;
  monaco.editor.setModelLanguage(model, languageId);
}

function disposeModelIfUnreferenced(model: Monaco.editor.ITextModel): void {
  if ([...models.values()].some((candidate) => candidate === model)) return;
  if (!model.isDisposed()) {
    clearFilesMonacoModelExplicitLanguage(model);
    model.dispose();
  }
}

export function disposeFilesMonacoModel(id: string): void {
  const model = models.get(id);
  models.delete(id);
  if (model) disposeModelIfUnreferenced(model);
}
