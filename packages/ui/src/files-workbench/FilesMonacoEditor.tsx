import { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { loadFilesMonaco } from "@/files-workbench/filesMonacoLoader.js";
import { applyFilesMonacoContextMenuLocaleForEditor } from "@/files-workbench/filesMonacoContextMenuBridge.js";
import {
  getOrCreateFilesMonacoModel,
  isWritingFilesMonacoModel,
  writeFilesMonacoModelValue,
} from "@/files-workbench/filesMonacoModels.js";
import {
  filesMonacoPathFromVirtualUri,
  filesMonacoTypescriptWorkspaceScope,
  normalizeFilesMonacoPath,
} from "@/files-workbench/filesMonacoTypescriptPath.js";
import type {
  FilesMonacoOpenPath,
  FilesMonacoRevealPosition,
  FilesTextBuffer,
} from "@/files-workbench/filesEditorTypes.js";

function positionFromSelectionOrPosition(
  selectionOrPosition: Monaco.IRange | Monaco.IPosition | undefined,
): { line: number; column: number } | undefined {
  if (!selectionOrPosition) return undefined;
  if ("startLineNumber" in selectionOrPosition) {
    return {
      line: selectionOrPosition.startLineNumber,
      column: selectionOrPosition.startColumn,
    };
  }
  return {
    line: selectionOrPosition.lineNumber,
    column: selectionOrPosition.column,
  };
}

function applyRevealPosition(
  editor: Monaco.editor.IStandaloneCodeEditor,
  buffer: FilesTextBuffer,
  revealPosition: FilesMonacoRevealPosition | undefined,
): boolean {
  if (
    !revealPosition ||
    !buffer.path ||
    filesMonacoTypescriptWorkspaceScope(revealPosition.workspace) !==
      filesMonacoTypescriptWorkspaceScope(buffer.workspace) ||
    normalizeFilesMonacoPath(revealPosition.path) !== normalizeFilesMonacoPath(buffer.path)
  ) {
    return false;
  }
  const position = {
    lineNumber: revealPosition.line,
    column: revealPosition.column,
  };
  editor.setPosition(position);
  editor.revealPositionInCenter(position);
  editor.focus();
  return true;
}

export function FilesMonacoEditor({
  buffer,
  onChange,
  onOpenPath,
  revealPosition,
  onRevealPositionApplied,
}: {
  buffer: FilesTextBuffer;
  onChange: (text: string) => void;
  onOpenPath?: FilesMonacoOpenPath;
  revealPosition?: FilesMonacoRevealPosition;
  onRevealPositionApplied?: (path: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onOpenPathRef = useRef(onOpenPath);
  const revealPositionRef = useRef(revealPosition);
  const onRevealPositionAppliedRef = useRef(onRevealPositionApplied);
  onChangeRef.current = onChange;
  onOpenPathRef.current = onOpenPath;
  revealPositionRef.current = revealPosition;
  onRevealPositionAppliedRef.current = onRevealPositionApplied;
  const theme = useZCodeStore((state) => state.theme);
  const monacoTheme = resolveTheme(theme) === "dark" ? "vs-dark" : "vs";

  const { intl } = useZCodeIntl();

  // Monaco 的 ESM 产物不带语言包，右键菜单默认英文；这里按当前语言改写菜单文案。
  // intl 随语言变化重建，所以切换语言会重新走一遍改写。
  useEffect(() => {
    let disposed = false;
    void loadFilesMonaco()
      .then(() => {
        if (disposed) {
          return;
        }
        applyFilesMonacoContextMenuLocaleForEditor((key) => intl.formatMessage({ id: key }));
      })
      .catch(() => {
        // 菜单本地化失败不影响编辑器本身，保留 Monaco 默认英文即可。
      });
    return () => {
      disposed = true;
    };
  }, [intl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
    let subscription: Monaco.IDisposable | undefined;
    let opener: Monaco.IDisposable | undefined;

    void loadFilesMonaco().then((monaco) => {
      if (disposed || !containerRef.current) {
        return;
      }
      const model = getOrCreateFilesMonacoModel(
        monaco,
        buffer.id,
        buffer.text,
        buffer.path,
        buffer.workspace,
      );
      writeFilesMonacoModelValue(model, buffer.text);
      editor = monaco.editor.create(containerRef.current, {
        model,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        theme: monacoTheme,
        padding: { top: 8 },
        fixedOverflowWidgets: true,
        links: true,
        gotoLocation: {
          multiple: "goto",
          multipleDefinitions: "goto",
        },
      });
      editorRef.current = editor;
      opener = monaco.editor.registerEditorOpener({
        async openCodeEditor(source, resource, selectionOrPosition) {
          // Monaco's default opener does nothing for another model unless the host handles it.
          // Scope each opener to its originating editor so a split pane cannot steal navigation.
          if (source !== editor) return false;
          const path = filesMonacoPathFromVirtualUri(buffer.workspace, resource);
          if (!path) return false;
          const position = positionFromSelectionOrPosition(selectionOrPosition);
          const handled = await onOpenPathRef.current?.(buffer.workspace, path, position);
          return handled === true;
        },
      });
      subscription = editor.onDidChangeModelContent(() => {
        // 程序化灌入会同步触发内容变更；再写回缓冲就会和换行规范化来回打，
        // 嵌套更新打到 React #185，整块文件区被错误边界接管。
        if (isWritingFilesMonacoModel()) {
          return;
        }
        onChangeRef.current(editor?.getValue() ?? "");
      });
      if (applyRevealPosition(editor, buffer, revealPositionRef.current)) {
        onRevealPositionAppliedRef.current?.(revealPositionRef.current!.path);
      }
    });

    return () => {
      disposed = true;
      subscription?.dispose();
      opener?.dispose();
      editorRef.current = null;
      editor?.dispose();
    };
  }, [buffer.id, buffer.path, buffer.workspace, monacoTheme]);

  useEffect(() => {
    void loadFilesMonaco().then((monaco) => {
      const model = getOrCreateFilesMonacoModel(
        monaco,
        buffer.id,
        buffer.text,
        buffer.path,
        buffer.workspace,
      );
      writeFilesMonacoModelValue(model, buffer.text);
    });
  }, [buffer.id, buffer.path, buffer.workspace, buffer.text]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !applyRevealPosition(editor, buffer, revealPosition)) return;
    if (revealPosition) onRevealPositionApplied?.(revealPosition.path);
  }, [buffer.path, buffer.workspace, onRevealPositionApplied, revealPosition]);

  return <div ref={containerRef} className="h-full min-h-0 w-full" />;
}
