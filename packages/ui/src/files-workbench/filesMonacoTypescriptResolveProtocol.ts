import type { ResolveCompilerOptionsInput } from "@/files-workbench/filesMonacoTypescriptModuleResolve.js";

export type FilesMonacoTypescriptResolveEntry = {
  path: string;
  text: string;
};

export type FilesMonacoTypescriptResolveFile = {
  path: string;
  content: string;
};

export type FilesMonacoTypescriptResolveOverrides = {
  baseUrlPath: string;
  paths?: Record<string, string[]>;
};

export type FilesMonacoTypescriptResolveLog = {
  level: "info" | "warn" | "error";
  message: string;
};

export type FilesMonacoTypescriptResolveResult = {
  files: FilesMonacoTypescriptResolveFile[];
  monacoOverrides?: FilesMonacoTypescriptResolveOverrides;
  nearestCompilerOptions?: ResolveCompilerOptionsInput;
  configDirectory?: string;
  /** 至少一个 bare specifier 解析成功时 > 0 */
  resolvedCount?: number;
  logs?: FilesMonacoTypescriptResolveLog[];
};
