import type * as Monaco from "monaco-editor";
import { configureFilesMonacoLanguageServices } from "@/files-workbench/filesMonacoLanguageServices.js";
import { configureFilesMonacoCustomLanguages } from "@/files-workbench/filesMonacoCustomLanguages.js";
import { configureFilesMonacoTypescriptCompiler } from "@/files-workbench/filesMonacoTypescriptCompiler.js";

let monacoPromise: Promise<typeof Monaco> | undefined;

export function loadFilesMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    const attempt = import("./filesMonacoEnvironment.js")
      .then(() => import("monaco-editor"))
      .then((monaco) => {
        configureFilesMonacoLanguageServices(monaco);
        configureFilesMonacoTypescriptCompiler(monaco);
        configureFilesMonacoCustomLanguages(monaco);
        return monaco;
      })
      .catch((error: unknown) => {
        // 初始化失败不能留下 rejected 缓存，否则重试会永久复用同一个失败结果。
        // 只清除本次失败；若旧尝试的 catch 晚于重试，不得清掉新写入的 promise。
        if (monacoPromise === attempt) {
          monacoPromise = undefined;
        }
        throw error;
      });
    monacoPromise = attempt;
  }
  return monacoPromise;
}
