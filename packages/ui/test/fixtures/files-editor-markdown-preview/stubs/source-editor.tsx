import { useEffect, useRef, useState } from "react";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import type { FilesTextBuffer } from "@/files-workbench/filesEditorTypes.js";

/**
 * 源码编辑器边界桩。
 *
 * 真实 Monaco 需要 worker/字体/样式资产管线，隔离夹具用 textarea 代替 UI 外壳，
 * 但刻意复刻 Monaco 的关键契约：
 * - 模型按 buffer.id 缓存在模块级（对应 filesMonacoModels 的 model cache）；
 * - 卸载/重挂编辑器不会丢模型，撤销栈属于模型而不是 React 组件。
 * 切换预览后回到源码仍可 Ctrl+Z，验证的是「组视图切换没有重建 buffer 身份/模型」，
 * 不是夹具自己实现的 Markdown 切换逻辑。
 */
type Model = {
  value: string;
  undo: string[];
  redo: string[];
};

const models = new Map<string, Model>();
const statusHandles = new Map<string, FilesEditorStatusHandle>();

function getModel(id: string, value: string): Model {
  let model = models.get(id);
  if (!model) {
    model = { value, undo: [], redo: [] };
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
  onChange,
  onStatusHandleChange,
}: {
  buffer: FilesTextBuffer;
  onChange: (text: string) => void;
  onStatusHandleChange?: (handle: FilesEditorStatusHandle | null) => void;
}) {
  const model = getModel(buffer.id, buffer.text);
  const [value, setValue] = useState(model.value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 对外交出与生产同形的状态栏句柄，让 GroupPane 的“预览上报 null / 源码恢复”可被验证。
  useEffect(() => {
    onStatusHandleChange?.(getStatusHandle(buffer.id));
    return () => onStatusHandleChange?.(null);
  }, [buffer.id, onStatusHandleChange]);

  // 外部（保存、撤销命令、其它分屏）改了 buffer.text 时同步模型。
  useEffect(() => {
    if (model.value === buffer.text) return;
    model.value = buffer.text;
    model.undo = [];
    model.redo = [];
    setValue(buffer.text);
  }, [buffer.text, model]);

  const commit = (next: string, pushUndo: boolean) => {
    if (next === model.value) return;
    if (pushUndo) {
      model.undo.push(model.value);
      model.redo = [];
    }
    model.value = next;
    setValue(next);
    onChange(next);
  };

  return (
    <textarea
      ref={textareaRef}
      data-testid="files-e2e-source-editor"
      data-buffer-id={buffer.id}
      className="files-e2e-source-editor"
      value={value}
      spellCheck={false}
      onChange={(event) => commit(event.target.value, true)}
      onKeyDown={(event) => {
        const mod = event.ctrlKey || event.metaKey;
        if (!mod) return;
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
          const previous = model.undo.pop();
          if (previous === undefined) return;
          event.preventDefault();
          model.redo.push(model.value);
          model.value = previous;
          setValue(previous);
          onChange(previous);
        } else if ((key === "z" && event.shiftKey) || key === "y") {
          const next = model.redo.pop();
          if (next === undefined) return;
          event.preventDefault();
          model.undo.push(model.value);
          model.value = next;
          setValue(next);
          onChange(next);
        }
      }}
    />
  );
}
