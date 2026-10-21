import type * as Monaco from "monaco-editor";
import { filesMonacoLanguageMatchFromPath } from "@/files-workbench/filesMonacoLanguage.js";
import { filesMonacoVirtualFileUri } from "@/files-workbench/filesMonacoTypescriptPath.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";
import type { FilesEditorLanguageSource } from "@/files-workbench/filesEditorLanguage.js";

const models = new Map<string, Monaco.editor.ITextModel>();

/**
 * 用户显式选定的语言，按 model uri 记录。
 *
 * 依据：模型被复用时（切标签页、内容重灌、重新解析）会再次套用推断出的语言，
 * 若没有这层记录，用户在状态栏手动改过的语言会被下一次推断覆盖回去。
 */
const explicitLanguages = new Map<string, string>();

/**
 * 内容级检测（guesslang）的结论，按 model uri 记录。
 *
 * 与用户显式选择分开存：两者都是「已经定过的语言」，但来源和失效条件不同。
 * 依据：模型复用时（每次键入都会重灌正文）会再次套用规则解析出的语言，
 * 若没有这层记录，内容级检测的结论会被兜底语言覆盖回去。
 */
const detectedLanguages = new Map<string, string>();

/**
 * 要套用到 model 上的语言：id 加上「为什么是这个语言」。
 *
 * 来源决定套用时的优先级，套用入口不自己重新解析路径。
 */
export interface FilesMonacoModelLanguage {
  languageId: string;
  source: FilesEditorLanguageSource;
}

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
  const key = model.uri.toString();
  explicitLanguages.set(key, languageId);
  // 显式选择是最终结论：内容级检测的结论就此作废，不允许之后被它顶回来。
  detectedLanguages.delete(key);
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
 * 记录内容级检测的结论。
 *
 * 与用户显式选择分开存：规则链没结论时用它，规则链有结论时它作废。
 */
export function setFilesMonacoModelDetectedLanguage(
  model: Monaco.editor.ITextModel,
  languageId: string,
): void {
  detectedLanguages.set(model.uri.toString(), languageId);
}

export function getFilesMonacoModelDetectedLanguage(
  model: Monaco.editor.ITextModel,
): string | undefined {
  return detectedLanguages.get(model.uri.toString());
}

export function clearFilesMonacoModelDetectedLanguage(model: Monaco.editor.ITextModel): void {
  detectedLanguages.delete(model.uri.toString());
}

/**
 * 把内容级检测的结论落到模型上。
 *
 * 返回是否接受这个结论：用户已显式选过语言时不接受（显式选择是最终结论）。
 */
export function applyFilesMonacoDetectedLanguage(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  languageId: string,
): boolean {
  if (getFilesMonacoModelExplicitLanguage(model)) return false;
  setFilesMonacoModelDetectedLanguage(model, languageId);
  if (model.getLanguageId() === languageId) return true;
  monaco.editor.setModelLanguage(model, languageId);
  return true;
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
  language?: FilesMonacoModelLanguage,
): Monaco.editor.ITextModel {
  const uri =
    path && workspace
      ? filesMonacoVirtualFileUri(monaco, workspace, path)
      : `inmemory://files/${encodeURIComponent(id)}`;
  // 语言由调用方解析后传入；未传时退回按路径推断，保证旧调用点仍可用。
  const resolvedLanguage = language ?? filesMonacoLanguageMatchFromPath(path);
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

  const model = monaco.editor.createModel(value, resolvedLanguage.languageId, modelUri);
  models.set(id, model);
  return model;
}

/**
 * 套用语言。优先级：用户显式选择 > 内容级检测结果 > 本次规则解析结果。
 *
 * 依据：内容级检测是异步的（Worker），结论回来后模型上可能是检测语言；
 * 而模型复用（每次键入都会重灌正文）会再次套用规则解析结果。
 * 若不区分来源，内容级检测的结论会被兜底语言覆盖回去。
 */
function applyFilesMonacoModelLanguage(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  language: FilesMonacoModelLanguage,
): void {
  // 用户显式选定过的模型保持原样，不被任何推断结果覆盖。
  if (getFilesMonacoModelExplicitLanguage(model)) return;
  const detected = getFilesMonacoModelDetectedLanguage(model);
  if (detected) {
    if (language.source === "default") {
      // 内置规则仍无结论：保留内容级检测的结论，不退回兜底语言。
      if (model.getLanguageId() !== detected) {
        monaco.editor.setModelLanguage(model, detected);
      }
      return;
    }
    // 规则链现在有结论了：检测结论过期，清掉并套用规则结果。
    clearFilesMonacoModelDetectedLanguage(model);
  }
  if (model.getLanguageId() === language.languageId) return;
  monaco.editor.setModelLanguage(model, language.languageId);
}

function disposeModelIfUnreferenced(model: Monaco.editor.ITextModel): void {
  if ([...models.values()].some((candidate) => candidate === model)) return;
  if (!model.isDisposed()) {
    clearFilesMonacoModelExplicitLanguage(model);
    clearFilesMonacoModelDetectedLanguage(model);
    model.dispose();
  }
}

export function disposeFilesMonacoModel(id: string): void {
  const model = models.get(id);
  models.delete(id);
  if (model) disposeModelIfUnreferenced(model);
}
