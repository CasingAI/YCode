import type * as Monaco from "monaco-editor";

let monacoPromise: Promise<typeof Monaco> | undefined;

export function loadFilesMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    monacoPromise = import("./filesMonacoEnvironment.js").then(() => import("monaco-editor"));
  }
  return monacoPromise;
}
