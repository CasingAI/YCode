import { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { loadFilesMonaco } from "@/files-workbench/filesMonacoLoader.js";
import {
  getOrCreateFilesMonacoModel,
  isWritingFilesMonacoModel,
  writeFilesMonacoModelValue,
} from "@/files-workbench/filesMonacoModels.js";
import type { FilesTextBuffer } from "@/files-workbench/filesEditorTypes.js";

export function FilesMonacoEditor({
  buffer,
  onChange,
}: {
  buffer: FilesTextBuffer;
  onChange: (text: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const theme = useZCodeStore((state) => state.theme);
  const monacoTheme = resolveTheme(theme) === "dark" ? "vs-dark" : "vs";

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
    let subscription: Monaco.IDisposable | undefined;

    void loadFilesMonaco().then((monaco) => {
      if (disposed || !containerRef.current) {
        return;
      }
      const model = getOrCreateFilesMonacoModel(monaco, buffer.id, buffer.text, buffer.path);
      writeFilesMonacoModelValue(model, buffer.text);
      editor = monaco.editor.create(containerRef.current, {
        model,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        theme: monacoTheme,
        padding: { top: 8 },
      });
      subscription = editor.onDidChangeModelContent(() => {
        // 程序化灌入会同步触发内容变更；再写回缓冲就会和换行规范化来回打，
        // 嵌套更新打到 React #185，整块文件区被错误边界接管。
        if (isWritingFilesMonacoModel()) {
          return;
        }
        onChangeRef.current(editor?.getValue() ?? "");
      });
    });

    return () => {
      disposed = true;
      subscription?.dispose();
      editor?.dispose();
    };
  }, [buffer.id, buffer.path, monacoTheme]);

  useEffect(() => {
    void loadFilesMonaco().then((monaco) => {
      const model = getOrCreateFilesMonacoModel(monaco, buffer.id, buffer.text, buffer.path);
      writeFilesMonacoModelValue(model, buffer.text);
    });
  }, [buffer.id, buffer.path, buffer.text]);

  return <div ref={containerRef} className="h-full min-h-0 w-full" />;
}
