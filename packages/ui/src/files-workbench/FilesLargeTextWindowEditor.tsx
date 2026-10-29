import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as Monaco from "monaco-editor";
import { Button } from "@/components/ui/button.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveTheme } from "@/useTheme.js";
import { loadFilesMonaco } from "@/files-workbench/filesMonacoLoader.js";
import { applyFilesMonacoContextMenuLocaleForEditor } from "@/files-workbench/filesMonacoContextMenuBridge.js";
import {
  createFilesMonacoStatusHandle,
  type FilesEditorStatusHandle,
} from "@/files-workbench/filesMonacoStatusHandle.js";
import {
  filesEditorFirstLine,
  resolveFilesEditorLanguage,
} from "@/files-workbench/filesEditorLanguage.js";
import { filesLargeTextWindowModelUri } from "@/files-workbench/filesLargeTextWindowTypes.js";
import { logger } from "@/logger.js";

export interface FilesLargeTextWindowSearchResult {
  /** 当前块内匹配总数。 */
  matches: number;
  /** 1-based 当前匹配序号；无匹配为 0。 */
  index: number;
}

/**
 * 大文本块编辑器的命令句柄。
 *
 * 编辑器实例仍是唯一所有者，外部只拿到「读当前片段 + 下发命令」的窄接口：
 * - `undo` / `redo` 已按 Store 的全 buffer 历史路由，不使用 Monaco 单模型历史；
 * - `copy` / `cut` / `paste` / `selectAll` 只作用于当前片段；
 * - `search` / `find` 只覆盖当前有界模型，不向后读盘。
 *
 * 文件工作台菜单的撤销 / 重做 / 查找可以与普通文本共用
 * `FilesEditorStatusHandle`（见 `onStatusHandleChange`）；本接口额外提供菜单
 * 复制 / 粘贴 / 全选所需的动作入口。
 */
export interface FilesLargeTextWindowEditorHandle {
  search: (query: string, direction: "next" | "previous") => FilesLargeTextWindowSearchResult;
  focus: () => void;
  hasFocus: () => boolean;
  subscribeFocus: (listener: (focused: boolean) => void) => () => void;
  /** 当前片段正文；程序化同步不会把它当作用户输入上报。 */
  getValue: () => string;
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  find: (options?: { replace?: boolean }) => boolean;
}

export interface FilesLargeTextWindowEditorProps {
  bufferId: string;
  /** Store 投影后的当前块文本（已含未保存修改）。 */
  content: string;
  path: string;
  /** 每次替换磁盘块 / 接受新版本时递增，用来保证模型 URI 唯一；普通键入不增。 */
  revision: number;
  label: string;
  /** 当前块是否可编辑；非法 UTF-8 块为 false。 */
  editable?: boolean;
  /** 用户输入；程序化灌入模型不会回调。 */
  onChange?: (text: string) => void;
  /** 菜单 / 快捷键撤销重做交给 Store 的全 buffer 历史。 */
  onUndo?: () => void;
  onRedo?: () => void;
  /**
   * 交出与普通文本同形的编辑器句柄，供现有菜单路由使用。
   * 其中 undo / redo 已路由到 Store，而不是 Monaco 单模型历史。
   */
  onStatusHandleChange?: (handle: FilesEditorStatusHandle | null) => void;
}

/**
 * 大文本固定块编辑器。
 *
 * 只创建一个与当前块等大的模型（≤ 256 KiB），切块时按 revision 整体替换并 dispose，
 * 不注册进 `filesMonacoModels` 的全局路径模型表，也不会成为工作区文件模型。
 * 正文同步分两条路径：
 * - 用户输入 → `onChange` 写回 Store；
 * - Store 投影变化 → `model.setValue`，期间抑制 `onChange`，避免来回改写。
 */
export const FilesLargeTextWindowEditor = forwardRef<
  FilesLargeTextWindowEditorHandle,
  FilesLargeTextWindowEditorProps
>(function FilesLargeTextWindowEditor(
  {
    bufferId,
    content,
    path,
    revision,
    label,
    editable = false,
    onChange,
    onUndo,
    onRedo,
    onStatusHandleChange,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<FilesLargeTextWindowEditorHandle | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null);
  /** 程序化 setValue 期间为 true：这次内容事件不是用户输入。 */
  const applyingContentRef = useRef(false);
  // 同一 buffer 的多个分屏共享窗口与 revision；模型 URI 必须再带上视图实例，
  // 否则第二个分屏 createModel 会因 URI 已被占用而抛错。
  const instanceId = useId();
  // 仅编辑器初始化失败状态，不改动窗口正文、offset 或版本；下一个 revision
  // 或用户重试都会重建本地 editor。
  const [initError, setInitError] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const theme = useZCodeStore((state) => state.theme);
  const monacoTheme = resolveTheme(theme) === "dark" ? "vs-dark" : "vs";
  const { intl } = useZCodeIntl();
  const { settings } = useSettings();
  const associations = settings?.fileLanguageAssociations;
  const firstLine = filesEditorFirstLine(content);
  const languageId = useMemo(
    () => resolveFilesEditorLanguage({ path, firstLine, associations }).languageId,
    [associations, firstLine, path],
  );

  // 创建编辑器时读取最新值，但不把这些值放进创建依赖：否则每次键入都会重建编辑器。
  const contentRef = useRef(content);
  const editableRef = useRef(editable);
  const languageRef = useRef(languageId);
  const monacoThemeRef = useRef(monacoTheme);
  const labelRef = useRef(label);
  const onChangeRef = useRef(onChange);
  const onUndoRef = useRef(onUndo);
  const onRedoRef = useRef(onRedo);
  const onStatusHandleChangeRef = useRef(onStatusHandleChange);
  contentRef.current = content;
  editableRef.current = editable;
  languageRef.current = languageId;
  monacoThemeRef.current = monacoTheme;
  labelRef.current = label;
  onChangeRef.current = onChange;
  onUndoRef.current = onUndo;
  onRedoRef.current = onRedo;
  onStatusHandleChangeRef.current = onStatusHandleChange;

  useImperativeHandle(
    ref,
    () => ({
      search: (query, direction) =>
        apiRef.current?.search(query, direction) ?? { matches: 0, index: 0 },
      focus: () => apiRef.current?.focus(),
      hasFocus: () => apiRef.current?.hasFocus() ?? false,
      subscribeFocus: (listener) => apiRef.current?.subscribeFocus(listener) ?? (() => {}),
      getValue: () => apiRef.current?.getValue() ?? "",
      undo: () => apiRef.current?.undo(),
      redo: () => apiRef.current?.redo(),
      selectAll: () => apiRef.current?.selectAll(),
      copy: () => apiRef.current?.copy(),
      cut: () => apiRef.current?.cut(),
      paste: () => apiRef.current?.paste(),
      find: (options) => apiRef.current?.find(options) ?? false,
    }),
    [],
  );

  // Monaco 的 ESM 产物不带语言包，右键菜单默认英文；按当前语言改写。
  useEffect(() => {
    let disposed = false;
    void loadFilesMonaco()
      .then(() => {
        if (disposed) return;
        applyFilesMonacoContextMenuLocaleForEditor((key) => intl.formatMessage({ id: key }));
      })
      .catch(() => {
        // 菜单本地化失败不影响编辑，保留 Monaco 默认英文即可。
      });
    return () => {
      disposed = true;
    };
  }, [intl]);

  // 主题切换不重建编辑器，避免丢失光标与滚动位置。
  useEffect(() => {
    let disposed = false;
    void loadFilesMonaco()
      .then((monaco) => {
        if (!disposed) monaco.editor.setTheme(monacoTheme);
      })
      .catch(() => {
        // 主题设置失败时保留当前主题。
      });
    return () => {
      disposed = true;
    };
  }, [monacoTheme]);

  // 语言变化只改模型，不重建编辑器。
  useEffect(() => {
    let disposed = false;
    void loadFilesMonaco()
      .then((monaco) => {
        const model = modelRef.current;
        if (disposed || !model || model.isDisposed()) return;
        if (model.getLanguageId() !== languageId) {
          monaco.editor.setModelLanguage(model, languageId);
        }
      })
      .catch(() => {
        // 语言不可用时保留原语言，不影响编辑。
      });
    return () => {
      disposed = true;
    };
  }, [languageId]);

  // 非法 UTF-8 块 / 加载中只读切换，不重建编辑器。
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !editable, domReadOnly: !editable });
  }, [editable]);

  // Store 投影变化：只在模型内容确实不同时灌入，避免与用户输入来回改写。
  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.isDisposed()) return;
    if (model.getValue() === content) return;
    applyingContentRef.current = true;
    try {
      model.setValue(content);
    } finally {
      applyingContentRef.current = false;
    }
  }, [content]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
    let model: Monaco.editor.ITextModel | undefined;
    let contentSubscription: Monaco.IDisposable | undefined;
    let statusHandle: FilesEditorStatusHandle | undefined;
    setInitError(null);

    void loadFilesMonaco()
      .then((monaco) => {
        if (disposed || !containerRef.current) return;
        const uri = monaco.Uri.parse(
          filesLargeTextWindowModelUri({ bufferId, instanceId, revision }),
        );
        model = monaco.editor.createModel(
          contentRef.current,
          languageRef.current,
          uri,
        );
        modelRef.current = model;
        editor = monaco.editor.create(containerRef.current, {
          model,
          theme: monacoThemeRef.current,
          automaticLayout: true,
          readOnly: !editableRef.current,
          domReadOnly: !editableRef.current,
          lineNumbers: "off",
          minimap: { enabled: false },
          largeFileOptimizations: true,
          wordWrap: "off",
          folding: false,
          glyphMargin: false,
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 0,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollBeyondLastLine: false,
          fontSize: 13,
          padding: { top: 8 },
          fixedOverflowWidgets: true,
          links: false,
          ariaLabel: labelRef.current,
        });
        editorRef.current = editor;

        contentSubscription = model.onDidChangeContent(() => {
          // 程序化 setValue 也会触发内容事件；再回调 Store 就形成回环。
          if (applyingContentRef.current) return;
          onChangeRef.current?.(model?.getValue() ?? "");
        });

        let lastQuery = "";
        let lastMatchIndex = 0;
        const search = (
          query: string,
          direction: "next" | "previous",
        ): FilesLargeTextWindowSearchResult => {
          const currentEditor = editor;
          const currentModel = model;
          if (!currentEditor || !currentModel || currentModel.isDisposed() || !query) {
            lastQuery = query;
            lastMatchIndex = 0;
            return { matches: 0, index: 0 };
          }
          // 搜索只覆盖当前块；不向后读盘，也不声称全文件无匹配。
          const matches = currentModel.findMatches(query, false, false, false, null, false);
          if (matches.length === 0) {
            lastQuery = query;
            lastMatchIndex = 0;
            return { matches: 0, index: 0 };
          }
          if (query !== lastQuery) {
            lastQuery = query;
            lastMatchIndex = direction === "next" ? 0 : matches.length - 1;
          } else {
            const step = direction === "next" ? 1 : -1;
            lastMatchIndex = (lastMatchIndex + step + matches.length) % matches.length;
          }
          const match = matches[lastMatchIndex];
          if (match) {
            currentEditor.setSelection(match.range);
            currentEditor.revealRangeInCenter(match.range);
            currentEditor.focus();
          }
          return { matches: matches.length, index: lastMatchIndex + 1 };
        };

        // 菜单 / 快捷键撤销重做：有 Store 回调时使用全 buffer 历史，
        // 不能让 Monaco 把当前块模型当成第二份历史。
        const runUndo = () => {
          const callback = onUndoRef.current;
          if (callback) {
            callback();
            editor?.focus();
            return;
          }
          void editor?.getModel()?.undo();
          editor?.focus();
        };
        const runRedo = () => {
          const callback = onRedoRef.current;
          if (callback) {
            callback();
            editor?.focus();
            return;
          }
          void editor?.getModel()?.redo();
          editor?.focus();
        };
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, runUndo);
        editor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
          runRedo,
        );
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, runRedo);

        const runAction = (actionId: string) => {
          const action = editor?.getAction(actionId);
          if (action) {
            void action.run();
          } else {
            editor?.focus();
          }
        };

        // 与普通文本同形的状态句柄；菜单路由只依赖 undo / redo / find / 焦点。
        statusHandle = createFilesMonacoStatusHandle(monaco, editor);
        const routedHandle: FilesEditorStatusHandle = {
          ...statusHandle,
          undo: runUndo,
          redo: runRedo,
        };

        apiRef.current = {
          search,
          focus: () => editor?.focus(),
          hasFocus: () => editor?.hasTextFocus() ?? false,
          subscribeFocus: (listener) => statusHandle?.subscribeFocus(listener) ?? (() => {}),
          getValue: () => (model && !model.isDisposed() ? model.getValue() : ""),
          undo: runUndo,
          redo: runRedo,
          selectAll: () => {
            const currentModel = editor?.getModel();
            if (!currentModel) return;
            editor?.setSelection(currentModel.getFullModelRange());
            editor?.focus();
          },
          copy: () => runAction("editor.action.clipboardCopyAction"),
          cut: () => runAction("editor.action.clipboardCutAction"),
          paste: () => runAction("editor.action.clipboardPasteAction"),
          find: (options) => statusHandle?.find(options) ?? false,
        };
        onStatusHandleChangeRef.current?.(routedHandle);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // Monaco 加载或模型创建失败时保留外壳与工具栏，并提供局部重试。
        const message = error instanceof Error ? error.message : String(error);
        setInitError(message);
        logger.warn("[FilesLargeTextWindow] 大文本块编辑器初始化失败", {
          bufferId,
          path,
          error: message,
        });
      });

    return () => {
      disposed = true;
      contentSubscription?.dispose();
      statusHandle?.dispose();
      onStatusHandleChangeRef.current?.(null);
      apiRef.current = null;
      editorRef.current = null;
      modelRef.current = null;
      editor?.dispose();
      model?.dispose();
    };
  }, [bufferId, initAttempt, instanceId, revision]);

  return (
    <div className="relative h-full min-h-0 w-full" data-files-large-text-editor="">
      <div ref={containerRef} className="h-full min-h-0 w-full" />
      {initError ? (
        <div
          role="alert"
          data-files-large-text-editor-error=""
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background px-4 text-center text-ui-sm text-foreground-subtle"
        >
          <span>{intl.formatMessage({ id: "filesWorkbench.largeText.editorInitFailed" })}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setInitAttempt((attempt) => attempt + 1)}
          >
            {intl.formatMessage({ id: "filesWorkbench.largeText.retry" })}
          </Button>
        </div>
      ) : null}
    </div>
  );
});
