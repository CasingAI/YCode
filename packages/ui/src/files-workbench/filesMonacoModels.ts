import type * as Monaco from "monaco-editor";
import { filesMonacoLanguageFromPath } from "@/files-workbench/filesMonacoLanguage.js";

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
): Monaco.editor.ITextModel {
  const existing = models.get(id);
  if (existing && !existing.isDisposed()) {
    return existing;
  }
  const model = monaco.editor.createModel(
    value,
    filesMonacoLanguageFromPath(path),
    monaco.Uri.parse(`inmemory://files/${encodeURIComponent(id)}`),
  );
  models.set(id, model);
  return model;
}

export function disposeFilesMonacoModel(id: string): void {
  const model = models.get(id);
  if (model && !model.isDisposed()) {
    model.dispose();
  }
  models.delete(id);
}
