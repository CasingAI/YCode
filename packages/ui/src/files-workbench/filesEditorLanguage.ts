import { matchFilesEditorAssociation } from "@/files-workbench/filesEditorLanguageAssociations.js";
import {
  filesMonacoLanguageMatchFromPath,
  type FilesMonacoLanguageSource,
} from "@/files-workbench/filesMonacoLanguage.js";

/**
 * 语言解析链：用户关联 → 内置文件名/模式/扩展名 → 首行规则 → 兜底。
 *
 * 这是文件工作台语言的唯一真源：打开文件时算一次，结果直接交给 Monaco model。
 * 解析本身是同步纯函数，不引入额外时序；`source` 说明「为什么是这个语言」，
 * 供状态栏与排查使用。
 */
export type FilesEditorLanguageSource = "user-file" | "user-pattern" | FilesMonacoLanguageSource;

export interface FilesEditorLanguageResolution {
  languageId: string;
  source: FilesEditorLanguageSource;
}

export interface FilesEditorLanguageInput {
  /** 文件路径；未保存的缓冲区可能没有路径。 */
  path?: string;
  /** 文件首行，供 shebang 规则判断。 */
  firstLine?: string;
  /** 用户文件关联表（模式/路径 → 语言 id）。 */
  associations?: Readonly<Record<string, string>>;
}

export function resolveFilesEditorLanguage(
  input: FilesEditorLanguageInput,
): FilesEditorLanguageResolution {
  const association = matchFilesEditorAssociation(input.associations, input.path);
  if (association) {
    return {
      languageId: association.languageId,
      source: association.kind === "file" ? "user-file" : "user-pattern",
    };
  }
  return filesMonacoLanguageMatchFromPath(input.path, input.firstLine);
}

/** 取文件首行；空内容返回 undefined，避免把空串当成首行参与匹配。 */
export function filesEditorFirstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n", 1)[0]?.replace(/\r$/, "");
  return line && line.length > 0 ? line : undefined;
}
