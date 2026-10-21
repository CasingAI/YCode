import { useCallback, useEffect, useMemo, useRef } from "react";
import type * as Monaco from "monaco-editor";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveTheme } from "@/useTheme.js";
import { loadFilesMonaco } from "@/files-workbench/filesMonacoLoader.js";
import { applyFilesMonacoContextMenuLocaleForEditor } from "@/files-workbench/filesMonacoContextMenuBridge.js";
import { createFilesMonacoStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import {
  applyFilesMonacoDetectedLanguage,
  getOrCreateFilesMonacoModel,
  isWritingFilesMonacoModel,
  writeFilesMonacoModelValue,
} from "@/files-workbench/filesMonacoModels.js";
import { getFilesLanguageDetectionBackend } from "@/files-workbench/filesLanguageDetectionBackend.js";
import {
  filesEditorFirstLine,
  resolveFilesEditorLanguage,
} from "@/files-workbench/filesEditorLanguage.js";
import {
  filesMonacoPathFromVirtualUri,
  filesMonacoTypescriptWorkspaceScope,
  normalizeFilesMonacoPath,
} from "@/files-workbench/filesMonacoTypescriptPath.js";
import type {
  FilesEditorFocusRequest,
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
  focusRequest,
  onFocusApplied,
  onStatusHandleChange,
}: {
  buffer: FilesTextBuffer;
  onChange: (text: string) => void;
  onOpenPath?: FilesMonacoOpenPath;
  revealPosition?: FilesMonacoRevealPosition;
  onRevealPositionApplied?: (path: string) => void;
  /** 打开文件后的聚焦意图：目标文件就是当前缓冲时把焦点交给编辑器。 */
  focusRequest?: FilesEditorFocusRequest;
  onFocusApplied?: (requestId: number) => void;
  onStatusHandleChange?: (handle: FilesEditorStatusHandle | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onOpenPathRef = useRef(onOpenPath);
  const revealPositionRef = useRef(revealPosition);
  const onRevealPositionAppliedRef = useRef(onRevealPositionApplied);
  const onStatusHandleChangeRef = useRef(onStatusHandleChange);
  const focusRequestRef = useRef(focusRequest);
  const onFocusAppliedRef = useRef(onFocusApplied);
  const bufferPathRef = useRef(buffer.path);
  // 已经消费过的聚焦请求号：同一个请求只生效一次。
  const consumedFocusRequestIdRef = useRef(0);
  onChangeRef.current = onChange;
  onOpenPathRef.current = onOpenPath;
  revealPositionRef.current = revealPosition;
  onRevealPositionAppliedRef.current = onRevealPositionApplied;
  onStatusHandleChangeRef.current = onStatusHandleChange;
  focusRequestRef.current = focusRequest;
  onFocusAppliedRef.current = onFocusApplied;
  bufferPathRef.current = buffer.path;
  const theme = useZCodeStore((state) => state.theme);
  const monacoTheme = resolveTheme(theme) === "dark" ? "vs-dark" : "vs";
  const { intl } = useZCodeIntl();

  /**
   * 消费聚焦意图：请求指向的就是当前缓冲时把焦点交给编辑器。
   * 只聚焦，不移动光标——打开文件不该把用户甩到第一行。
   */
  const applyPendingFocusRequest = useCallback((editor: Monaco.editor.IStandaloneCodeEditor) => {
    const request = focusRequestRef.current;
    const path = bufferPathRef.current;
    if (!request || !path) {
      return false;
    }
    if (request.requestId <= consumedFocusRequestIdRef.current) {
      return false;
    }
    if (normalizeFilesMonacoPath(request.path) !== normalizeFilesMonacoPath(path)) {
      return false;
    }
    consumedFocusRequestIdRef.current = request.requestId;
    editor.focus();
    onFocusAppliedRef.current?.(request.requestId);
    return true;
  }, []);

  // 语言解析：用户关联 → 内置文件名/模式/扩展名 → 首行规则。
  // 首行取自缓冲正文（无扩展名脚本靠它识别），键是字符串，编辑正文其它位置时保持稳定。
  const { settings } = useSettings();
  const associations = settings?.fileLanguageAssociations;
  const firstLine = filesEditorFirstLine(buffer.text);
  const resolution = useMemo(
    () =>
      resolveFilesEditorLanguage({
        path: buffer.path,
        firstLine,
        associations,
      }),
    [associations, buffer.path, firstLine],
  );
  const languageId = resolution.languageId;
  const languageSource = resolution.source;
  // 套用语言时必须带来源：内置规则没结论时才能复用内容级检测的结论。
  const language = useMemo(
    () => ({ languageId, source: languageSource }),
    [languageId, languageSource],
  );
  // 建编辑器的 effect 不能因语言变化而重建编辑器（会丢光标与滚动位置），
  // 语言变化由下面的内容 effect 单独套用。
  const languageRef = useRef(language);
  languageRef.current = language;

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
    let statusHandle: FilesEditorStatusHandle | undefined;

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
        languageRef.current,
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
      // 聚焦请求可能早于编辑器创建发出：编辑器就绪这一刻消费掉。
      applyPendingFocusRequest(editor);
      // 状态栏句柄：编辑器仍是唯一所有者，这里只把「读状态 + 下发命令」窄接口交出去。
      statusHandle = createFilesMonacoStatusHandle(monaco, editor);
      onStatusHandleChangeRef.current?.(statusHandle);
    });

    return () => {
      disposed = true;
      subscription?.dispose();
      opener?.dispose();
      statusHandle?.dispose();
      onStatusHandleChangeRef.current?.(null);
      editorRef.current = null;
      editor?.dispose();
    };
  }, [applyPendingFocusRequest, buffer.id, buffer.path, buffer.workspace, monacoTheme]);

  useEffect(() => {
    void loadFilesMonaco().then((monaco) => {
      const model = getOrCreateFilesMonacoModel(
        monaco,
        buffer.id,
        buffer.text,
        buffer.path,
        buffer.workspace,
        language,
      );
      writeFilesMonacoModelValue(model, buffer.text);
    });
  }, [buffer.id, buffer.path, buffer.workspace, buffer.text, language]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !applyRevealPosition(editor, buffer, revealPosition)) return;
    if (revealPosition) onRevealPositionApplied?.(revealPosition.path);
  }, [buffer.path, buffer.workspace, onRevealPositionApplied, revealPosition]);

  // 目标文件已经打开着：聚焦请求到达时直接把焦点交给当前编辑器。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    applyPendingFocusRequest(editor);
  }, [applyPendingFocusRequest, focusRequest]);

  // 内容级兜底：只有内置规则完全没结论（source 为 default）时才看内容。
  // 检测在 Worker 里跑，异步回来后覆盖语言；用户显式选过语言时不覆盖。
  // 依赖里不放 buffer.text：正文每次键入都变，那会让检测跟着反复触发。
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const bufferIsEmpty = buffer.text.length === 0;
  useEffect(() => {
    if (language.source !== "default" || bufferIsEmpty) {
      return;
    }
    const current = bufferRef.current;
    let cancelled = false;
    void loadFilesMonaco()
      .then(async (monaco) => {
        const model = getOrCreateFilesMonacoModel(
          monaco,
          current.id,
          current.text,
          current.path,
          current.workspace,
          language,
        );
        const detected = await getFilesLanguageDetectionBackend().detect(current.text);
        if (cancelled || !detected) {
          return;
        }
        // 落到模型上：显式选择优先，否则记为该 model 的内容级检测结论。
        // 模型复用时（每次键入都会重灌正文）要保留这个结论，
        // 否则会被兜底语言覆盖回去。
        applyFilesMonacoDetectedLanguage(monaco, model, detected);
      })
      .catch(() => {
        // 内容级检测不可用时保持原语言，不影响编辑。
      });
    return () => {
      cancelled = true;
    };
  }, [buffer.id, bufferIsEmpty, language]);

  return <div ref={containerRef} className="h-full min-h-0 w-full" />;
}
