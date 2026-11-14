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
  createFilesMonacoTextDocument,
  filesMonacoModelForTextDocument,
  findFilesMonacoModel,
  getOrCreateFilesMonacoModel,
  isWritingFilesMonacoModel,
  writeFilesMonacoModelValue,
} from "@/files-workbench/filesMonacoModels.js";
import { getFilesLanguageDetectionBackend } from "@/files-workbench/filesLanguageDetectionBackend.js";
import { resolveFilesEditorLanguage } from "@/files-workbench/filesEditorLanguage.js";
import {
  activeFilesTextDocument,
  filesTextBufferFirstLine,
  filesTextBufferIsEmpty,
  snapshotFilesTextBuffer,
} from "@/files-workbench/filesTextDocumentModel.js";
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
  FilesTextDocumentBinding,
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
  onAttachTextDocument,
  onDetachTextDocument,
  onTextDocumentChange,
  onOpenPath,
  revealPosition,
  onRevealPositionApplied,
  focusRequest,
  onFocusApplied,
  onStatusHandleChange,
}: {
  buffer: FilesTextBuffer;
  /** 模型就绪后把运行时正文文档交给 Store；Store 仍是状态唯一所有者。 */
  onAttachTextDocument?: (bufferId: string, document: FilesTextDocumentBinding) => void;
  /** 卸载前先固化正文快照，再解除绑定。 */
  onDetachTextDocument?: (bufferId: string, document: FilesTextDocumentBinding) => void;
  /** 局部输入：只通知变化，不传正文。 */
  onTextDocumentChange?: (bufferId: string) => void;
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
  const onAttachTextDocumentRef = useRef(onAttachTextDocument);
  const onDetachTextDocumentRef = useRef(onDetachTextDocument);
  const onTextDocumentChangeRef = useRef(onTextDocumentChange);
  const onOpenPathRef = useRef(onOpenPath);
  const revealPositionRef = useRef(revealPosition);
  const onRevealPositionAppliedRef = useRef(onRevealPositionApplied);
  const onStatusHandleChangeRef = useRef(onStatusHandleChange);
  const focusRequestRef = useRef(focusRequest);
  const onFocusAppliedRef = useRef(onFocusApplied);
  const bufferPathRef = useRef(buffer.path);
  // 已经消费过的聚焦请求号：同一个请求只生效一次。
  const consumedFocusRequestIdRef = useRef(0);
  onAttachTextDocumentRef.current = onAttachTextDocument;
  onDetachTextDocumentRef.current = onDetachTextDocument;
  onTextDocumentChangeRef.current = onTextDocumentChange;
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
  // 首行只读有界区间；绑定文档时不会因超长单行扫描整份正文。
  const firstLine = filesTextBufferFirstLine(buffer);
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
    let textDocument: FilesTextDocumentBinding | undefined;

    void loadFilesMonaco().then((monaco) => {
      if (disposed || !containerRef.current) {
        return;
      }
      // 同一 model 已被其它分屏视图持有：正文权威在模型里，不再复制 / 比较全文。
      const existing = findFilesMonacoModel(monaco, buffer.id, buffer.path, buffer.workspace);
      const bound = activeFilesTextDocument(buffer);
      const reusesBound =
        existing !== undefined &&
        bound !== undefined &&
        filesMonacoModelForTextDocument(bound) === existing;
      const initialText = reusesBound ? "" : snapshotFilesTextBuffer(buffer);
      const model = getOrCreateFilesMonacoModel(
        monaco,
        buffer.id,
        initialText,
        buffer.path,
        buffer.workspace,
        languageRef.current,
      );
      // 新建模型已带初始正文；仅复用旧模型且无权威绑定时才写回缓冲快照。
      if (!reusesBound && existing !== undefined) writeFilesMonacoModelValue(model, initialText);
      textDocument = createFilesMonacoTextDocument(model);
      editor = monaco.editor.create(containerRef.current, {
        model,
        automaticLayout: true,
        // 旧会话可能留下被 256 KiB 截断的文本缓冲；这种缓冲禁止编辑，避免把片段保存回整份文件。
        readOnly: buffer.truncated === true,
        domReadOnly: buffer.truncated === true,
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
        // 逐键路径只通知变化；正文与版本号都由模型持有，不在回调里读全文。
        onTextDocumentChangeRef.current?.(buffer.id);
      });
      if (textDocument) onAttachTextDocumentRef.current?.(buffer.id, textDocument);
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
      // 模型可能随后被回收；先把当前正文固化成 Store 快照再解除绑定。
      if (textDocument) onDetachTextDocumentRef.current?.(buffer.id, textDocument);
      editor?.dispose();
    };
  }, [
    applyPendingFocusRequest,
    buffer.id,
    buffer.path,
    buffer.truncated,
    buffer.workspace,
    monacoTheme,
  ]);

  useEffect(() => {
    let disposed = false;
    void loadFilesMonaco().then((monaco) => {
      // 改名或删除可能早于 Monaco 加载完成；旧缓冲不能重新注册已经回收的路径模型。
      if (disposed) return;
      const existing = findFilesMonacoModel(monaco, buffer.id, buffer.path, buffer.workspace);
      // 当前编辑器已使用权威模型时只需重新套用语言；重灌正文会多复制并比较全文。
      if (existing && editorRef.current?.getModel() === existing) {
        getOrCreateFilesMonacoModel(monaco, buffer.id, "", buffer.path, buffer.workspace, language);
        return;
      }
      const value = snapshotFilesTextBuffer(buffer);
      const model = getOrCreateFilesMonacoModel(
        monaco,
        buffer.id,
        value,
        buffer.path,
        buffer.workspace,
        language,
      );
      if (existing) writeFilesMonacoModelValue(model, value);
    });
    return () => {
      disposed = true;
    };
    // 正文变化不进入依赖：已绑定模型的正文就是权威副本，逐键重灌会覆盖撤销历史。
  }, [buffer.id, buffer.path, buffer.workspace, language]);

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
  const bufferIsEmpty = filesTextBufferIsEmpty(buffer);
  useEffect(() => {
    if (language.source !== "default" || bufferIsEmpty) {
      return;
    }
    const current = bufferRef.current;
    let cancelled = false;
    void loadFilesMonaco()
      .then(async (monaco) => {
        if (cancelled) return;
        const text = snapshotFilesTextBuffer(current);
        const model = getOrCreateFilesMonacoModel(
          monaco,
          current.id,
          text,
          current.path,
          current.workspace,
          language,
        );
        const detected = await getFilesLanguageDetectionBackend().detect(text);
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
