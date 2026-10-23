import type * as Monaco from "monaco-editor";
import { setFilesMonacoModelExplicitLanguage } from "@/files-workbench/filesMonacoModels.js";
import {
  filesEditorClampGotoColumnNumber,
  filesEditorClampGotoLineNumber,
  filesEditorEolFromMonaco,
  filesEditorIndentKind,
  filesEditorLanguageLabel,
  filesEditorSortMarkers,
  filesEditorStatusEqual,
} from "@/files-workbench/filesEditorStatusModel.js";
import type {
  FilesEditorEol,
  FilesEditorGotoTarget,
  FilesEditorStatusLanguage,
  FilesEditorStatusMarker,
  FilesEditorStatusSnapshot,
} from "@/files-workbench/filesEditorStatusModel.js";

export type { FilesEditorStatusLanguage };

/** 状态栏一次对外暴露的完整状态：快照 + 当前文件的诊断。 */
export interface FilesEditorStatusState {
  snapshot: FilesEditorStatusSnapshot;
  markers: FilesEditorStatusMarker[];
}

/**
 * 状态栏对编辑器的窄接口。
 *
 * 编辑器实例归 `FilesMonacoEditor` 所有；这里只把「读状态」和「下发命令」
 * 两类能力收成一个句柄，不把 Monaco 原始对象透传给 UI 层。
 * 规格见 docs/specs/files-editor-status-bar.md。
 */
export interface FilesEditorStatusHandle {
  getState(): FilesEditorStatusState;
  getLanguages(): FilesEditorStatusLanguage[];
  subscribe(listener: (state: FilesEditorStatusState) => void): () => void;
  goToLine(target: FilesEditorGotoTarget): void;
  setIndentation(next: { insertSpaces: boolean; tabSize: number }): void;
  setLanguage(languageId: string): void;
  setEol(eol: FilesEditorEol): void;
  revealMarker(marker: FilesEditorStatusMarker): void;
  /** 文本区此刻是否持有焦点（菜单点击会让网页失焦，撤销/重做据此判断作用对象）。 */
  hasFocus(): boolean;
  /**
   * 订阅文本区焦点变化（true = 获得焦点）。
   * 桌面菜单的撤销 / 重做 / 查找按「操作前的编辑焦点」路由，
   * 需要知道编辑器什么时候拿到过焦点，因此这里单独开一路焦点事件。
   */
  subscribeFocus(listener: (focused: boolean) => void): () => void;
  /** 撤销一次编辑。 */
  undo(): void;
  /** 重做一次编辑。 */
  redo(): void;
  /** 打开编辑器自带的查找（replace 为真时打开查找替换）；不支持时返回 false。 */
  find(options?: { replace?: boolean }): boolean;
  dispose(): void;
}

function filesEditorMarkerSeverity(
  monaco: typeof Monaco,
  severity: Monaco.MarkerSeverity,
): FilesEditorStatusMarker["severity"] {
  if (severity === monaco.MarkerSeverity.Error) return "error";
  if (severity === monaco.MarkerSeverity.Warning) return "warning";
  return "info";
}

function filesEditorMarkersEqual(
  left: readonly FilesEditorStatusMarker[],
  right: readonly FilesEditorStatusMarker[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftMarker = left[index];
    const rightMarker = right[index];
    if (!leftMarker || !rightMarker) return false;
    if (
      leftMarker.id !== rightMarker.id ||
      leftMarker.severity !== rightMarker.severity ||
      leftMarker.message !== rightMarker.message ||
      leftMarker.lineNumber !== rightMarker.lineNumber ||
      leftMarker.column !== rightMarker.column
    ) {
      return false;
    }
  }
  return true;
}

export function createFilesMonacoStatusHandle(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
): FilesEditorStatusHandle {
  const listeners = new Set<(state: FilesEditorStatusState) => void>();
  const focusListeners = new Set<(focused: boolean) => void>();
  const disposables: Monaco.IDisposable[] = [];
  let modelDisposables: Monaco.IDisposable[] = [];
  let disposed = false;
  let focused = editor.hasTextFocus();

  /** 文本区焦点变化：只在真正翻转时通知，避免高频无谓回调。 */
  const notifyFocus = (next: boolean) => {
    if (disposed || next === focused) return;
    focused = next;
    for (const listener of focusListeners) {
      listener(next);
    }
  };

  const readSnapshot = (): FilesEditorStatusSnapshot => {
    const model = editor.getModel();
    const position = editor.getPosition();
    // 缩进取 model 的已解析选项：Monaco 在建 model 时会按文件内容探测缩进，
    // 这正是 VS Code 状态栏显示的“文件实际缩进”。编辑器的计算选项只存在
    // 内部数组里（getOptions() 不暴露属性），不能直接读。
    const modelOptions = model?.getOptions();
    return {
      lineNumber: position?.lineNumber ?? 1,
      column: position?.column ?? 1,
      lineCount: model?.getLineCount() ?? 0,
      languageId: model?.getLanguageId() ?? "plaintext",
      indentKind: filesEditorIndentKind(modelOptions?.insertSpaces ?? true),
      tabSize: modelOptions?.tabSize ?? 2,
      eol: filesEditorEolFromMonaco(model?.getEOL()),
    };
  };

  const readMarkers = (): FilesEditorStatusMarker[] => {
    const model = editor.getModel();
    if (!model) return [];
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    return filesEditorSortMarkers(
      markers.map((marker, index) => ({
        id: `${marker.owner}:${marker.startLineNumber}:${marker.startColumn}:${index}`,
        severity: filesEditorMarkerSeverity(monaco, marker.severity),
        message: marker.message,
        lineNumber: marker.startLineNumber,
        column: marker.startColumn,
      })),
    );
  };

  const readState = (): FilesEditorStatusState => ({
    snapshot: readSnapshot(),
    markers: readMarkers(),
  });

  let lastState: FilesEditorStatusState = readState();

  const notify = () => {
    if (disposed) return;
    const next = readState();
    // 内容变化最频繁（每次键入都会触发）。状态没变就不通知，
    // 避免状态栏在打字过程中反复重渲染。
    if (
      filesEditorMarkersEqual(lastState.markers, next.markers) &&
      filesEditorStatusEqual(lastState.snapshot, next.snapshot)
    ) {
      return;
    }
    lastState = next;
    for (const listener of listeners) {
      listener(next);
    }
  };

  const bindModel = (model: Monaco.editor.ITextModel | null) => {
    for (const disposable of modelDisposables) {
      disposable.dispose();
    }
    modelDisposables = [];
    if (!model) return;
    modelDisposables.push(
      model.onDidChangeContent(() => notify()),
      model.onDidChangeOptions(() => notify()),
    );
  };

  disposables.push(
    editor.onDidChangeCursorPosition(() => notify()),
    editor.onDidChangeConfiguration(() => notify()),
    editor.onDidChangeModel(() => {
      bindModel(editor.getModel());
      notify();
    }),
    editor.onDidFocusEditorWidget(() => notifyFocus(true)),
    editor.onDidBlurEditorWidget(() => notifyFocus(false)),
    monaco.editor.onDidChangeModelLanguage(() => notify()),
    monaco.editor.onDidChangeMarkers(() => notify()),
  );
  bindModel(editor.getModel());

  return {
    getState: () => readState(),
    getLanguages: () =>
      monaco.languages.getLanguages().map((language) => {
        const aliases = language.aliases ?? [];
        return {
          id: language.id,
          label: filesEditorLanguageLabel({ id: language.id, aliases }),
          aliases,
          extensions: language.extensions ?? [],
        };
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    goToLine(target) {
      const model = editor.getModel();
      if (!model || model.getLineCount() === 0) return;
      // 行列按 VS Code gotoLineQuickAccess 的规则夹取而不是拒绝：
      // 行夹到 [1, 行数]（负数从末尾倒数），列按夹取后的行夹到 [1, 行长 + 1]，
      // 超界输入（如 9999:9999）落到最后一行行尾。规格见 docs/specs/files-editor-status-bar.md。
      const lineNumber = filesEditorClampGotoLineNumber(target.line, model.getLineCount());
      const position = {
        lineNumber,
        column: filesEditorClampGotoColumnNumber(
          target.column ?? 1,
          model.getLineMaxColumn(lineNumber),
        ),
      };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
      notify();
    },
    setIndentation(next) {
      const model = editor.getModel();
      if (!model) return;
      // 改 model 的已解析选项：插入文本时的缩进规范化走的就是这组值，
      // 改完会触发 onDidChangeOptions，状态栏随之刷新。
      // indentSize 必须一起改：插入时的缩进宽度取的是 indentSize，
      // 只改 tabSize 会出现「状态栏显示 4、实际仍按 2 缩进」的不一致。
      model.updateOptions({
        insertSpaces: next.insertSpaces,
        tabSize: next.tabSize,
        indentSize: next.tabSize,
      });
      notify();
    },
    setLanguage(languageId) {
      const model = editor.getModel();
      if (!model) return;
      // 记为「用户显式选定」：此后模型被复用时，推断结果不得覆盖它。
      setFilesMonacoModelExplicitLanguage(model, languageId);
      if (model.getLanguageId() === languageId) {
        notify();
        return;
      }
      monaco.editor.setModelLanguage(model, languageId);
      notify();
    },
    setEol(eol) {
      const model = editor.getModel();
      if (!model) return;
      const expected = eol === "CRLF" ? "\r\n" : "\n";
      if (model.getEOL() === expected) return;
      // 走 model.setEOL 而不是「先改缓冲再灌模型」：
      // setEOL 会触发一次 EOL 变更内容事件，正好复用既有的内容回写通道，
      // 避免两次内容变更把缓冲与模型打成交替改写。
      model.setEOL(
        eol === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
      );
      notify();
    },
    revealMarker(marker) {
      const position = { lineNumber: marker.lineNumber, column: marker.column };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
    },
    hasFocus() {
      return editor.hasTextFocus();
    },
    subscribeFocus(listener) {
      focusListeners.add(listener);
      return () => {
        focusListeners.delete(listener);
      };
    },
    undo() {
      const model = editor.getModel();
      if (!model) return;
      void model.undo();
    },
    redo() {
      const model = editor.getModel();
      if (!model) return;
      void model.redo();
    },
    find(options) {
      // 查找/查找替换复用 Monaco 自带动作，不另建实现：
      // 'actions.find' 与 'editor.action.startFindReplaceAction' 都是编辑器动作，
      // 由编辑器贡献注册，编辑器实例是唯一所有者。
      const action = editor.getAction(
        options?.replace ? "editor.action.startFindReplaceAction" : "actions.find",
      );
      if (!action) return false;
      void action.run();
      return true;
    },
    dispose() {
      disposed = true;
      listeners.clear();
      focusListeners.clear();
      for (const disposable of modelDisposables) {
        disposable.dispose();
      }
      modelDisposables = [];
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
}
