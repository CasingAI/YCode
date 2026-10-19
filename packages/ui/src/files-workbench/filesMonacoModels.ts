import type * as Monaco from "monaco-editor";
import { filesMonacoLanguageFromPath } from "@/files-workbench/filesMonacoLanguage.js";
import { filesMonacoVirtualFileUri } from "@/files-workbench/filesMonacoTypescriptPath.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

const models = new Map<string, Monaco.editor.ITextModel>();

/** 程序化 setValue 期间为真。内容变更回调必须跳过，否则规范化差异会来回写缓冲。 */
let writingFilesMonacoModel = 0;

export interface FilesMonacoModelLike {
  getValue(): string;
  setValue(value: string): void;
}

export function isWritingFilesMonacoModel(): boolean {
  return writingFilesMonacoModel > 0;
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
): Monaco.editor.ITextModel {
  const uri =
    path && workspace
      ? filesMonacoVirtualFileUri(monaco, workspace, path)
      : `inmemory://files/${encodeURIComponent(id)}`;
  const existing = models.get(id);
  if (existing && !existing.isDisposed()) {
    if (existing.uri.toString() === uri) {
      const language = filesMonacoLanguageFromPath(path);
      if (existing.getLanguageId() !== language) {
        monaco.editor.setModelLanguage(existing, language);
      }
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
    const language = filesMonacoLanguageFromPath(path);
    if (existingByUri.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(existingByUri, language);
    }
    return existingByUri;
  }

  const model = monaco.editor.createModel(value, filesMonacoLanguageFromPath(path), modelUri);
  models.set(id, model);
  return model;
}

function disposeModelIfUnreferenced(model: Monaco.editor.ITextModel): void {
  if ([...models.values()].some((candidate) => candidate === model)) return;
  if (!model.isDisposed()) model.dispose();
}

export function disposeFilesMonacoModel(id: string): void {
  const model = models.get(id);
  models.delete(id);
  if (model) disposeModelIfUnreferenced(model);
}
