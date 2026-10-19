import type * as Monaco from "monaco-editor";
import { filesMonacoVirtualFileUri } from "@/files-workbench/filesMonacoTypescriptPath.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";

export const FILES_MONACO_TYPESCRIPT_MODULE_RESOLUTION_BUNDLER = 100;

export interface FilesMonacoTypescriptCompilerOverrides {
  baseUrlPath: string;
  paths?: Record<string, string[]>;
}

export interface FilesMonacoTypescriptExtraLib {
  workspace: FilesWorkspaceRef;
  path: string;
  content: string;
}

function baseCompilerOptions(monaco: typeof Monaco): Monaco.typescript.CompilerOptions {
  return {
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution:
      FILES_MONACO_TYPESCRIPT_MODULE_RESOLUTION_BUNDLER as Monaco.typescript.ModuleResolutionKind,
    allowImportingTsExtensions: true,
    jsx: monaco.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    isolatedModules: true,
    skipLibCheck: true,
    noEmit: true,
  };
}

export function configureFilesMonacoTypescriptCompiler(monaco: typeof Monaco): void {
  const options = baseCompilerOptions(monaco);
  for (const defaults of [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ]) {
    defaults.setCompilerOptions({ ...options });
    defaults.setEagerModelSync(true);
  }
}

export function applyFilesMonacoTypescriptCompilerOverrides(
  monaco: typeof Monaco,
  workspace: FilesWorkspaceRef | undefined,
  overrides: FilesMonacoTypescriptCompilerOverrides | undefined,
): void {
  const options = baseCompilerOptions(monaco);
  if (workspace && overrides) {
    options.baseUrl = filesMonacoVirtualFileUri(monaco, workspace, overrides.baseUrlPath);
    if (overrides.paths) options.paths = overrides.paths;
  }
  monaco.typescript.typescriptDefaults.setCompilerOptions({ ...options });
  monaco.typescript.javascriptDefaults.setCompilerOptions({ ...options });
}

export function setFilesMonacoTypescriptExtraLibs(
  monaco: typeof Monaco,
  libs: readonly FilesMonacoTypescriptExtraLib[],
): void {
  const extraLibs = libs.map((lib) => ({
    content: lib.content,
    filePath: filesMonacoVirtualFileUri(monaco, lib.workspace, lib.path),
  }));
  monaco.typescript.typescriptDefaults.setExtraLibs(extraLibs);
  monaco.typescript.javascriptDefaults.setExtraLibs(extraLibs);
}
