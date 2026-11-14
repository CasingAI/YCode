import type * as Monaco from "monaco-editor";
import {
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import type { FilesEditorStore } from "@/files-workbench/filesEditorStore.js";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import {
  activeFilesTextDocument,
  filesTextBufferFirstLine,
  snapshotFilesTextBuffer,
} from "@/files-workbench/filesTextDocumentModel.js";
import type {
  EditorSnapshot,
  FirstLineProbe,
  MemoryProbe,
  MonacoInfo,
  QuickTextState,
  SaveEvent,
  SnapshotTiming,
  SplitLayoutInfo,
  StoreSnapshot,
  TokenProbe,
} from "./probes.js";
import {
  modelMatchesPath,
  withCountersSuspended,
  withCountersSuspendedAsync,
} from "./probeRuntime.js";
import { tokenProbe } from "./probes.js";

/**
 * 只读探针：读取生产 Store / Monaco 模型 / IndexedDB 后的可序列化结果。
 *
 * 这里不拥有任何业务状态；所有读取都经过生产快照函数或在计数区间之外进行。
 */

export function readStoreSnapshot(api: FilesEditorStore, saveEvents: SaveEvent[]): StoreSnapshot {
  const state = api.getState();
  return withCountersSuspended(() => ({
    activeId: state.activeId,
    buffers: state.buffers.map((buffer) => {
      // 每个缓冲只做一次显式快照；绑定模型时 text 字段可能落后于用户输入。
      const text = buffer.kind === "text" ? snapshotFilesTextBuffer(buffer) : undefined;
      return {
        id: buffer.id,
        kind: buffer.kind,
        path: buffer.path,
        title: buffer.title,
        dirty: isFilesBufferDirty(buffer),
        loadState: buffer.kind === "text" ? buffer.loadState : undefined,
        loadError: buffer.kind === "text" ? buffer.loadError : undefined,
        textLength: text?.length,
        savedTextLength: buffer.kind === "text" ? buffer.savedText.length : undefined,
        diskVersion: buffer.kind === "text" ? buffer.diskVersion : undefined,
        head: text?.slice(0, 80),
        tail: text?.slice(-160),
      };
    }),
    saveEvents: [...saveEvents],
    logs: window.__fullTextE2E?.logs ?? [],
    toasts: window.__fullTextE2E?.toasts ?? [],
  }));
}

export function readEditorSnapshot(
  api: FilesEditorStore,
  handle: FilesEditorStatusHandle | null,
  handleBufferId: string | undefined,
): EditorSnapshot | undefined {
  const state = api.getState();
  if (handleBufferId !== state.activeId) return undefined;
  if (!handle) return undefined;
  const snapshotState = handle.getState().snapshot;
  return {
    lineNumber: snapshotState.lineNumber,
    column: snapshotState.column,
    lineCount: snapshotState.lineCount,
    languageId: snapshotState.languageId,
    eol: snapshotState.eol,
  };
}

export function readBufferTokens(
  api: FilesEditorStore,
  tokens: string[],
): TokenProbe[] | undefined {
  const state = api.getState();
  const buffer = findFilesBuffer(state, state.activeId);
  if (!buffer || !isFilesTextBuffer(buffer)) return undefined;
  // 正文 owner 是绑定模型（未挂载时回退缓冲快照），探针必须读显式快照。
  return withCountersSuspended(() => {
    const text = snapshotFilesTextBuffer(buffer);
    return tokens.map((token) => tokenProbe(text, token));
  });
}

export function readQuickTextState(api: FilesEditorStore): QuickTextState | undefined {
  const state = api.getState();
  const buffer = findFilesBuffer(state, state.activeId);
  if (!buffer || !isFilesTextBuffer(buffer)) return undefined;
  return withCountersSuspended(() => {
    const document = activeFilesTextDocument(buffer);
    return {
      dirty: isFilesBufferDirty(buffer),
      textLength: document?.getLength() ?? buffer.text.length,
      savedTextLength: buffer.savedText.length,
      diskVersion: buffer.diskVersion,
      documentRevision: buffer.documentRevision,
      savedDocumentVersionId: buffer.savedDocumentVersionId,
      textChangeEpoch: state.textChangeEpoch,
      modelVersionId: document?.getVersionId(),
    };
  });
}

export function readSnapshotTiming(api: FilesEditorStore): SnapshotTiming | undefined {
  const state = api.getState();
  const buffer = findFilesBuffer(state, state.activeId);
  if (!buffer || !isFilesTextBuffer(buffer)) return undefined;
  return withCountersSuspended(() => {
    const started = performance.now();
    const text = snapshotFilesTextBuffer(buffer);
    // Monaco 可能返回惰性拼接字符串；读取末字符强制真正物化，避免把 O(1)
    // 的 cons-string 创建误报成完整快照耗时。
    if (text.length > 0) text.charCodeAt(text.length - 1);
    return { textLength: text.length, ms: Math.round((performance.now() - started) * 1000) / 1000 };
  });
}

export function readMemoryProbe(): MemoryProbe {
  // Chromium 的 performance.memory 是非标准、近似值；测不到时明确返回不可用，
  // 不拿正在运行的 YCode 进程数据代替。
  const memory = (
    performance as unknown as {
      memory?: {
        usedJSHeapSize?: number;
        totalJSHeapSize?: number;
        jsHeapSizeLimit?: number;
      };
    }
  ).memory;
  if (!memory) {
    return { available: false, source: "performance.memory unavailable" };
  }
  return {
    available: true,
    source: "performance.memory (Chromium non-standard, approximate)",
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  };
}

export async function activeEditorFor(api: FilesEditorStore): Promise<{
  editor: Monaco.editor.IStandaloneCodeEditor | undefined;
  model: Monaco.editor.ITextModel | undefined;
}> {
  const activePath = findFilesBuffer(api.getState(), api.getState().activeId)?.path;
  const monaco = await import("monaco-editor");
  const editors = monaco.editor.getEditors();
  const editor =
    editors.find((candidate) => modelMatchesPath(candidate.getModel(), activePath)) ?? editors[0];
  return { editor, model: editor?.getModel() ?? undefined };
}

export function readFirstLineProbe(api: FilesEditorStore): Promise<FirstLineProbe | undefined> {
  const state = api.getState();
  const buffer = findFilesBuffer(state, state.activeId);
  if (!buffer || !isFilesTextBuffer(buffer)) return Promise.resolve(undefined);
  const activePath = buffer.path;
  return withCountersSuspendedAsync(async () => {
    const started = performance.now();
    const line = filesTextBufferFirstLine(buffer, 2048) ?? "";
    const ms = Math.round((performance.now() - started) * 1000) / 1000;
    const monaco = await import("monaco-editor");
    const models = monaco.editor.getModels();
    const model = models.find((candidate) => modelMatchesPath(candidate, activePath)) ?? models[0];
    return {
      textLength: line.length,
      ms,
      lineCount: model?.getLineCount() ?? 0,
      lineMaxColumn: model?.getLineMaxColumn(1) ?? 0,
      languageId: model?.getLanguageId() ?? "",
    };
  });
}

/** 真实分屏状态：editor 数量、共享 model 身份、布局组与缓冲引用计数。 */
export async function readSplitLayoutInfo(api: FilesEditorStore): Promise<SplitLayoutInfo> {
  const state = api.getState();
  const buffer = findFilesBuffer(state, state.activeId);
  const monaco = await import("monaco-editor");
  return withCountersSuspendedAsync(async () => {
    const editors = monaco.editor.getEditors();
    const models = [
      ...new Set(editors.map((editor) => editor.getModel()).filter((model) => model !== null)),
    ];
    const document = buffer?.kind === "text" ? activeFilesTextDocument(buffer) : undefined;
    return {
      activeId: state.activeId,
      editorCount: editors.length,
      editorModelIds: editors.map((editor) => editor.getModel()?.id),
      modelUris: models.map((model) => model.uri.toString()),
      modelVersionIds: models.map((model) => model.getAlternativeVersionId()),
      groups: Object.values(state.layout.groups).map((group) => ({
        groupId: group.id,
        focused: group.id === state.layout.focusedGroupId,
        views: group.views.map((view) => ({ id: view.id, bufferId: view.bufferId })),
      })),
      buffer:
        buffer?.kind === "text"
          ? {
              id: buffer.id,
              dirty: isFilesBufferDirty(buffer),
              textLength: document?.getLength() ?? buffer.text.length,
              documentAttachments: buffer.documentAttachments,
              documentRevision: buffer.documentRevision,
              savedDocumentVersionId: buffer.savedDocumentVersionId,
              modelVersionId: document?.getVersionId(),
            }
          : undefined,
    };
  });
}

export async function readModelSummary(
  api: FilesEditorStore,
): Promise<{ valueLength: number; lineCount: number; languageId: string } | undefined> {
  // O(1) 摘要，不复制任何行内容；10 MiB 单行场景不能把整行传回 Node 侧。
  const activePath = findFilesBuffer(api.getState(), api.getState().activeId)?.path;
  const monaco = await import("monaco-editor");
  return withCountersSuspendedAsync(async () => {
    const models = monaco.editor.getModels();
    const model = models.find((candidate) => modelMatchesPath(candidate, activePath)) ?? models[0];
    if (!model) return undefined;
    return {
      valueLength: model.getValueLength(),
      lineCount: model.getLineCount(),
      languageId: model.getLanguageId(),
    };
  });
}

export async function readMonacoInfo(
  api: FilesEditorStore,
  tokens: string[],
  lines: number[] = [],
): Promise<MonacoInfo | undefined> {
  // 直接读取生产 FilesMonacoEditor 创建的真实 Monaco 模型，不另建替代模型。
  // 多个大文件场景可能共存模型，必须按当前缓冲路径选择，不能只按第一个。
  const activePath = findFilesBuffer(api.getState(), api.getState().activeId)?.path;
  const monaco = await import("monaco-editor");
  return withCountersSuspendedAsync(async () => {
    const models = monaco.editor.getModels();
    const model = models.find((candidate) => modelMatchesPath(candidate, activePath)) ?? models[0];
    if (!model) return undefined;
    const lastLine = model.getLineCount();
    const lineTexts = lines.map((line) => {
      const clamped = Math.min(Math.max(line, 1), lastLine);
      return { line: clamped, text: model.getLineContent(clamped) };
    });
    return {
      valueLength: model.getValueLength(),
      lineCount: lastLine,
      firstLine: model.getLineContent(1),
      lastLine: model.getLineContent(lastLine),
      tail: [
        model.getLineContent(Math.max(1, lastLine - 2)),
        model.getLineContent(Math.max(1, lastLine - 1)),
        model.getLineContent(lastLine),
      ]
        .join("\n")
        .slice(-200),
      tokens: tokens.map((token) => {
        const matches = model.findMatches(token, false, false, false, null, false);
        return {
          token,
          count: matches.length,
          positions: matches.slice(0, 4).map((match) => ({
            line: match.range.startLineNumber,
            column: match.range.startColumn,
            offset: model.getOffsetAt({
              lineNumber: match.range.startLineNumber,
              column: match.range.startColumn,
            }),
          })),
        };
      }),
      lineTexts,
    };
  });
}
