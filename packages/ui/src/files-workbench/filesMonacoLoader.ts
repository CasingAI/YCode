import type * as Monaco from "monaco-editor";
import { configureFilesMonacoLanguageServices } from "@/files-workbench/filesMonacoLanguageServices.js";
import { configureFilesMonacoCustomLanguages } from "@/files-workbench/filesMonacoCustomLanguages.js";
import { configureFilesMonacoTypescriptCompiler } from "@/files-workbench/filesMonacoTypescriptCompiler.js";

let monacoPromise: Promise<typeof Monaco> | undefined;

export function loadFilesMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    monacoPromise = import("./filesMonacoEnvironment.js")
      .then(() => import("monaco-editor"))
      .then((monaco) => {
        configureFilesMonacoLanguageServices(monaco);
        configureFilesMonacoTypescriptCompiler(monaco);
        configureFilesMonacoCustomLanguages(monaco);
        return monaco;
      });
  }
  return monacoPromise;
}
