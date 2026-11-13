import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// 使用生产全局样式，让标签条 / 状态栏依赖的真实 Tailwind 工具类生效。
import "../../../src/styles.css";
import "./fixture.css";

import { FilesEditorGroupPane } from "@/files-workbench/FilesEditorGroupPane.js";
import {
  FilesEditorStoreProvider,
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";
import { useFilesEditorSessionPersistence } from "@/files-workbench/useFilesEditorSessionPersistence.js";
import { useFilesEditorRestore } from "@/files-workbench/useFilesEditorRestore.js";
import { useFilesWorkbenchOpen } from "@/files-workbench/useFilesWorkbenchOpen.js";
import {
  findFilesBuffer,
  isFilesBufferDirty,
  isFilesTextBuffer,
} from "@/files-workbench/filesEditorModel.js";
import { saveFilesTextBuffer } from "@/files-workbench/filesEditorSaveIO.js";
import { FILES_TEXT_DRAFT_DB_NAME } from "@/files-workbench/filesTextDraftStorage.js";
import type { FilesEditorLayoutNode } from "@/files-workbench/filesEditorLayout.js";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";
import type { IServiceAccessor } from "@zcode/services";
import { fixtureFileService } from "./fileService.js";
import {
  readDraftRecords,
  readSessionInfo,
  tokenProbe,
  type EditorSnapshot,
  type MonacoInfo,
  type MountMode,
  type SaveEvent,
  type StoreSnapshot,
  type TokenProbe,
} from "./probes.js";

/**
 * 隔离夹具入口：真实 FilesEditorGroupPane + 真实 filesEditorStore +
 * 真实 FilesMonacoEditor（从 monaco-editor 打包）+ 生产打开 / 保存 / 恢复链路。
 *
 * 只替换 i18n、settings、toast、logger、应用 store、平台与非文本预览分支。
 * 不提供替代编辑器，也不在夹具里重写读取决策或编辑逻辑。
 */

const WORKSPACE: FilesWorkspaceRef = {
  workspacePath: "/workspace/e2e",
  workspaceIdentity: "ws-e2e",
};

function listGroupIds(node: FilesEditorLayoutNode): string[] {
  if (node.type === "leaf") return [node.groupId];
  return [...listGroupIds(node.children[0]), ...listGroupIds(node.children[1])];
}

function Workbench({ mode }: { mode: MountMode }) {
  const api = useFilesEditorStoreApi();
  const layout = useFilesEditorStore((state) => state.layout);
  const buffers = useFilesEditorStore((state) => state.buffers);
  const persistence = useFilesEditorSessionPersistence(api);
  const saveEventsRef = useRef<SaveEvent[]>([]);
  const handleRef = useRef<FilesEditorStatusHandle | null>(null);
  const handleBufferIdRef = useRef<string | undefined>(undefined);

  const resolveServices = useCallback(
    (_workspace: FilesWorkspaceRef) =>
      ({ fileService: fixtureFileService }) as unknown as IServiceAccessor,
    [],
  );

  const { loadRestoredTextFile, isRestoreLoadTracked } = useFilesEditorRestore({
    store: api,
    restoreEnabled: mode === "restore",
    persist: persistence.persist,
    loadSession: persistence.load,
    resolveServices,
  });

  const openExistingPath = useFilesWorkbenchOpen({
    store: api,
    persist: persistence.persist,
    resolveServices,
    loadRestoredTextFile,
    isRestoreLoadTracked,
    reopenLargeTextFile: async () => {},
  });

  const saveActive = useCallback(async () => {
    const state = api.getState();
    const buffer = findFilesBuffer(state, state.activeId);
    if (!buffer || !isFilesTextBuffer(buffer) || !buffer.path) {
      saveEventsRef.current.push({ type: "skip", reason: "not-a-savable-text-buffer" });
      return { ok: false, events: [...saveEventsRef.current] };
    }
    // 生产保存链路：saveFilesTextBuffer -> IFileService.commitTextFile(full)。
    const ok = await saveFilesTextBuffer({
      store: api,
      buffer,
      path: buffer.path,
      fileService: fixtureFileService,
      onConflict: (info) =>
        saveEventsRef.current.push({
          type: "conflict",
          path: info.path,
          observedVersion: info.observedVersion ?? null,
          deleted: info.deleted,
        }),
      onSaveFailed: (path) => saveEventsRef.current.push({ type: "failed", path }),
      onBusy: () => saveEventsRef.current.push({ type: "busy" }),
      onSaved: ({ path }) => {
        saveEventsRef.current.push({ type: "saved", path });
        persistence.persist();
      },
    });
    saveEventsRef.current.push({ type: "result", ok });
    return { ok, events: [...saveEventsRef.current] };
  }, [api, persistence]);

  const snapshot = useCallback((): StoreSnapshot => {
    const state = api.getState();
    return {
      activeId: state.activeId,
      buffers: state.buffers.map((buffer) => ({
        id: buffer.id,
        kind: buffer.kind,
        path: buffer.path,
        title: buffer.title,
        dirty: isFilesBufferDirty(buffer),
        loadState: buffer.kind === "text" ? buffer.loadState : undefined,
        loadError: buffer.kind === "text" ? buffer.loadError : undefined,
        textLength: buffer.kind === "text" ? buffer.text.length : undefined,
        savedTextLength: buffer.kind === "text" ? buffer.savedText.length : undefined,
        diskVersion: buffer.kind === "text" ? buffer.diskVersion : undefined,
        head: buffer.kind === "text" ? buffer.text.slice(0, 80) : undefined,
        tail: buffer.kind === "text" ? buffer.text.slice(-160) : undefined,
      })),
      saveEvents: [...saveEventsRef.current],
      logs: window.__fullTextE2E?.logs ?? [],
      toasts: window.__fullTextE2E?.toasts ?? [],
    };
  }, [api]);

  const editorSnapshot = useCallback((): EditorSnapshot | undefined => {
    const state = api.getState();
    if (handleBufferIdRef.current !== state.activeId) return undefined;
    const handle = handleRef.current;
    if (!handle) return undefined;
    const snapshotState = handle.getState().snapshot;
    return {
      lineNumber: snapshotState.lineNumber,
      column: snapshotState.column,
      lineCount: snapshotState.lineCount,
      languageId: snapshotState.languageId,
      eol: snapshotState.eol,
    };
  }, [api]);

  const goToLine = useCallback((line: number, column = 1) => {
    handleRef.current?.goToLine({ line, column });
  }, []);

  const monacoInfo = useCallback(
    async (tokens: string[], lines: number[] = []): Promise<MonacoInfo | undefined> => {
      // 直接读取生产 FilesMonacoEditor 创建的真实 Monaco 模型，不另建替代模型。
      const monaco = await import("monaco-editor");
      const models = monaco.editor.getModels();
      const model =
        models.find((candidate) => candidate.uri.path.includes("e2e-large.json")) ?? models[0];
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
    },
    [],
  );

  // 通过 Monaco 公开 API 聚焦真实编辑器，之后的 Ctrl+F / Ctrl+End 仍是真实键盘事件。
  const focusEditor = useCallback(async () => {
    const monaco = await import("monaco-editor");
    const editors = monaco.editor.getEditors();
    const editor =
      editors.find((candidate) => candidate.getModel()?.uri.path.includes("e2e-large.json")) ??
      editors[0];
    if (!editor) return false;
    editor.focus();
    return editor.hasTextFocus();
  }, []);

  const bufferTokens = useCallback(
    (tokens: string[]): TokenProbe[] | undefined => {
      const state = api.getState();
      const buffer = findFilesBuffer(state, state.activeId);
      if (!buffer || !isFilesTextBuffer(buffer)) return undefined;
      return tokens.map((token) => tokenProbe(buffer.text, token));
    },
    [api],
  );

  const onEditorHandleChange = useCallback(
    (_groupId: string, handle: FilesEditorStatusHandle | null, bufferId?: string) => {
      handleRef.current = handle;
      handleBufferIdRef.current = bufferId;
    },
    [],
  );

  const onSave = useCallback(
    (bufferId: string) => {
      void (async () => {
        if (api.getState().activeId !== bufferId) {
          api.getState().setActiveId(bufferId);
        }
        await saveActive();
      })();
    },
    [api, saveActive],
  );

  useLayoutEffect(() => {
    window.__fullTextE2E ??= {};
    Object.assign(window.__fullTextE2E, {
      openPath: (path: string) => openExistingPath(WORKSPACE, path),
      snapshot,
      editorSnapshot,
      goToLine,
      monacoInfo,
      focusEditor,
      bufferTokens,
      saveActive,
      persistNow: persistence.persist,
      sessionInfo: readSessionInfo,
      draftRecords: readDraftRecords,
      saveEvents: saveEventsRef.current,
      logs: window.__fullTextE2E?.logs ?? [],
      toasts: window.__fullTextE2E?.toasts ?? [],
    });
  }, [
    bufferTokens,
    editorSnapshot,
    focusEditor,
    goToLine,
    monacoInfo,
    openExistingPath,
    persistence.persist,
    saveActive,
    snapshot,
  ]);

  const groupIds = useMemo(() => listGroupIds(layout.root), [layout.root]);

  return (
    <div className="files-e2e-app" data-files-e2e-ready="true" data-files-e2e-mode={mode}>
      {groupIds.map((groupId) => {
        const group = layout.groups[groupId];
        if (!group) return null;
        const focused = layout.focusedGroupId === groupId;
        return (
          <div key={groupId} className="files-e2e-pane" data-files-e2e-group-host={groupId}>
            <FilesEditorGroupPane
              group={group}
              buffers={buffers}
              isActiveView={focused}
              hasEnteredFiles
              isFocused={focused}
              loadRestoredTextFile={loadRestoredTextFile}
              onActivate={(viewId) => api.getState().activateView(viewId)}
              onKeepOpen={() => {}}
              onClose={() => {}}
              onCloseOthers={() => {}}
              onCloseToRight={() => {}}
              onCloseSaved={() => {}}
              onCloseAll={() => {}}
              canCloseSaved={false}
              onCopyPath={() => {}}
              onRevealInFileTree={() => {}}
              canRevealInFileTree={() => false}
              onMoveView={(viewId, targetGroupId, targetIndex) =>
                api.getState().moveViewToGroup(viewId, targetGroupId, targetIndex)
              }
              onSplit={(viewId, targetGroupId, edge, splitMode) =>
                api.getState().splitViewToEdge(viewId, targetGroupId, edge, splitMode)
              }
              onChange={(bufferId, text) => api.getState().updateText(bufferId, text)}
              onOpenPath={() => false}
              onRevealPositionApplied={() => {}}
              focusRequest={undefined}
              onFocusApplied={() => {}}
              onCreateUntitled={() => api.getState().createUntitled(WORKSPACE)}
              onSave={onSave}
              onSaveAs={() => {}}
              onSetMarkdownViewMode={(viewId, nextMode) =>
                api.getState().setViewMarkdownViewMode(viewId, nextMode)
              }
              onFocusGroup={(targetGroupId) => api.getState().focusGroup(targetGroupId)}
              onEditorHandleChange={onEditorHandleChange}
              onExternalChangeAction={() => {}}
            />
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const [request, setRequest] = useState<{ key: number; mode: MountMode } | null>(null);
  const keyRef = useRef(0);

  useLayoutEffect(() => {
    window.__fullTextE2E ??= {};
    window.__fullTextE2E.saveEvents = [];
    window.__fullTextE2E.logs = [];
    window.__fullTextE2E.toasts = [];
    window.__fullTextE2E.mount = (options) => {
      keyRef.current += 1;
      window.__fullTextE2E!.saveEvents = [];
      window.__fullTextE2E!.logs = [];
      window.__fullTextE2E!.toasts = [];
      setRequest({ key: keyRef.current, mode: options?.mode ?? "fresh" });
    };
    window.__fullTextE2E.clearStorage = async () => {
      window.localStorage.clear();
      await new Promise<void>((resolveDelete) => {
        const factory = globalThis.indexedDB;
        if (!factory) {
          resolveDelete();
          return;
        }
        const deletion = factory.deleteDatabase(FILES_TEXT_DRAFT_DB_NAME);
        deletion.onsuccess = () => resolveDelete();
        deletion.onerror = () => resolveDelete();
        deletion.onblocked = () => {
          // 旧连接的 versionchange 会关闭数据库，删除随后继续；这里不提前返回。
        };
        setTimeout(resolveDelete, 5000);
      });
    };
  }, []);

  if (!request) return null;
  return (
    <FilesEditorStoreProvider key={request.key}>
      <Workbench mode={request.mode} />
    </FilesEditorStoreProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root");
createRoot(rootElement).render(<App />);
