import { useEffect, useRef, useState } from "react";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import type {
  FilesTextBuffer,
  FilesTextDocumentBinding,
} from "@/files-workbench/filesEditorTypes.js";

/**
 * 源码编辑器边界桩。
 *
 * 真实 Monaco 需要 worker/字体/样式资产管线，隔离夹具用 textarea 代替 UI 外壳，
 * 但刻意复刻 Monaco 的关键契约：
 * - 模型按 buffer.id 缓存在模块级（对应 filesMonacoModels 的 model cache）；
 * - 局部输入只通知 `onTextDocumentChange`，正文通过绑定文档读取；
 * - 替代版本号随编辑前进，撤销回到保存点时回到同一版本号。
 */
type Model = {
  value: string;
  versionId: number;
  undo: Array<{ value: string; versionId: number }>;
  redo: Array<{ value: string; versionId: number }>;
};

const models = new Map<string, Model>();
const statusHandles = new Map<string, FilesEditorStatusHandle>();

function getModel(id: string, value: string): Model {
  let model = models.get(id);
  if (!model) {
    model = { value, versionId: 1, undo: [], redo: [] };
    models.set(id, model);
  }
  return model;
}

// 复刻 Monaco 的句柄生命周期：句柄属于模型/编辑器，切换预览不重建。
function getStatusHandle(id: string): FilesEditorStatusHandle {
  const existing = statusHandles.get(id);
  if (existing) return existing;
  const handle: FilesEditorStatusHandle = {
    getState: () => {
      const model = models.get(id);
      const lineCount = Math.max(1, (model?.value ?? "").split("\n").length);
      return {
        snapshot: {
          lineNumber: 1,
          column: 1,
          lineCount,
          languageId: "markdown",
          indentKind: "spaces",
          tabSize: 2,
          eol: "LF",
        },
        markers: [],
      };
    },
    getLanguages: () => [
      { id: "markdown", label: "Markdown", aliases: ["markdown"], extensions: [".md"] },
    ],
    subscribe: () => () => {},
    goToLine: () => {},
    setIndentation: () => {},
    setLanguage: () => {},
    setEol: () => {},
    revealMarker: () => {},
    hasFocus: () => false,
    subscribeFocus: () => () => {},
    undo: () => {},
    redo: () => {},
    find: () => false,
    dispose: () => {},
  };
  statusHandles.set(id, handle);
  return handle;
}

export function FilesMonacoEditor({
  buffer,
  onAttachTextDocument,
  onDetachTextDocument,
  onTextDocumentChange,
  onStatusHandleChange,
}: {
  buffer: FilesTextBuffer;
  onAttachTextDocument?: (bufferId: string, document: FilesTextDocumentBinding) => void;
  onDetachTextDocument?: (bufferId: string, document: FilesTextDocumentBinding) => void;
  onTextDocumentChange?: (bufferId: string) => void;
  onStatusHandleChange?: (handle: FilesEditorStatusHandle | null) => void;
}) {
  const model = getModel(buffer.id, buffer.text);
  const [value, setValue] = useState(model.value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const document: FilesTextDocumentBinding = {
      getText: () => model.value,
      getVersionId: () => model.versionId,
      replaceText: (text) => {
        if (model.value === text) return;
        model.value = text;
        model.versionId += 1;
        model.undo = [];
        model.redo = [];
        setValue(text);
      },
      getFirstLine: () => model.value.split("\n", 1)[0]?.slice(0, 2048) || undefined,
      getLength: () => model.value.length,
      isDisposed: () => false,
    };
    onAttachTextDocument?.(buffer.id, document);
    return () => onDetachTextDocument?.(buffer.id, document);
  }, [buffer.id, model, onAttachTextDocument, onDetachTextDocument]);

  // 对外交出与生产同形的状态栏句柄，让 GroupPane 的“预览上报 null / 源码恢复”可被验证。
  useEffect(() => {
    onStatusHandleChange?.(getStatusHandle(buffer.id));
    return () => onStatusHandleChange?.(null);
  }, [buffer.id, onStatusHandleChange]);

  const commit = (next: string) => {
    if (next === model.value) return;
    model.undo.push({ value: model.value, versionId: model.versionId });
    model.redo = [];
    model.value = next;
    model.versionId += 1;
    setValue(next);
    onTextDocumentChange?.(buffer.id);
  };

  return (
    <textarea
      ref={textareaRef}
      data-testid="files-e2e-source-editor"
      data-buffer-id={buffer.id}
      className="files-e2e-source-editor"
      value={value}
      spellCheck={false}
      onChange={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        const mod = event.ctrlKey || event.metaKey;
        if (!mod) return;
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
          const previous = model.undo.pop();
          if (previous === undefined) return;
          event.preventDefault();
          model.redo.push({ value: model.value, versionId: model.versionId });
          model.value = previous.value;
          model.versionId = previous.versionId;
          setValue(previous.value);
          onTextDocumentChange?.(buffer.id);
        } else if ((key === "z" && event.shiftKey) || key === "y") {
          const next = model.redo.pop();
          if (next === undefined) return;
          event.preventDefault();
          model.undo.push({ value: model.value, versionId: model.versionId });
          model.value = next.value;
          model.versionId = next.versionId;
          setValue(next.value);
          onTextDocumentChange?.(buffer.id);
        }
      }}
    />
  );
}
