import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { FilesEditorGroupPane } from "@/files-workbench/FilesEditorGroupPane.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";
import { findFilesBuffer, isFilesTextBuffer } from "@/files-workbench/filesEditorModel.js";
import { saveFilesTextBuffer } from "@/files-workbench/filesEditorSaveIO.js";
import type { FilesEditorLayoutNode } from "@/files-workbench/filesEditorLayout.js";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import type { FilesWorkspaceRef } from "@/files-workbench/filesEditorTypes.js";
import { useFilesEditorRestore } from "@/files-workbench/useFilesEditorRestore.js";
import { useFilesEditorSessionPersistence } from "@/files-workbench/useFilesEditorSessionPersistence.js";
import { useFilesWorkbenchOpen } from "@/files-workbench/useFilesWorkbenchOpen.js";
import type { IServiceAccessor } from "@zcode/services";
import { fixtureFileService } from "./fileService.js";
import {
  activeEditorFor,
  readBufferTokens,
  readEditorSnapshot,
  readFirstLineProbe,
  readMemoryProbe,
  readModelSummary,
  readMonacoInfo,
  readQuickTextState,
  readSnapshotTiming,
  readSplitLayoutInfo,
  readStoreSnapshot,
} from "./probeReads.js";
import {
  installIdbCounters,
  installPrototypeCounters,
  installStorageCounters,
  snapshotProbeCounters,
  startMeasureCounters,
  stopMeasureCounters,
  summarizeKeypressMetrics,
  type KeypressMetricsState,
} from "./probeRuntime.js";
import {
  readDraftParts,
  readDraftRecords,
  readSessionInfo,
  SESSION_STORAGE_KEY,
  type KeypressMetricSummary,
  type MountMode,
  type SaveEvent,
  type SnapshotTiming,
  type SplitLayoutInfo,
  type TypingMeasure,
} from "./probes.js";

/**
 * 隔离夹具里的真实工作台：生产 Store + GroupPane + Monaco + 打开 / 保存 / 恢复，
 * 只把探针读取与计数包装拆到 `probeReads.ts` / `probeRuntime.ts`。
 */

const WORKSPACE: FilesWorkspaceRef = {
  workspacePath: "/workspace/e2e",
  workspaceIdentity: "ws-e2e",
};

function listGroupIds(node: FilesEditorLayoutNode): string[] {
  if (node.type === "leaf") return [node.groupId];
  return [...listGroupIds(node.children[0]), ...listGroupIds(node.children[1])];
}

export function Workbench({ mode }: { mode: MountMode }) {
  const api = useFilesEditorStoreApi();
  const layout = useFilesEditorStore((state) => state.layout);
  const buffers = useFilesEditorStore((state) => state.buffers);
  const persistence = useFilesEditorSessionPersistence(api);
  const saveEventsRef = useRef<SaveEvent[]>([]);
  const handleRef = useRef<FilesEditorStatusHandle | null>(null);
  const handleBufferIdRef = useRef<string | undefined>(undefined);
  const keypressMetricsRef = useRef<KeypressMetricsState | null>(null);

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

  const snapshot = useCallback(() => readStoreSnapshot(api, saveEventsRef.current), [api]);
  const editorSnapshot = useCallback(
    () => readEditorSnapshot(api, handleRef.current, handleBufferIdRef.current),
    [api],
  );
  const goToLine = useCallback((line: number, column = 1) => {
    handleRef.current?.goToLine({ line, column });
  }, []);
  const monacoInfo = useCallback(
    async (tokens: string[], lines: number[] = []) => readMonacoInfo(api, tokens, lines),
    [api],
  );
  const modelSummary = useCallback(() => readModelSummary(api), [api]);
  const focusEditor = useCallback(async () => {
    const { editor } = await activeEditorFor(api);
    if (!editor) return false;
    editor.focus();
    return editor.hasTextFocus();
  }, [api]);
  const bufferTokens = useCallback((tokens: string[]) => readBufferTokens(api, tokens), [api]);
  const quickTextState = useCallback(() => readQuickTextState(api), [api]);
  const timeSnapshot = useCallback(
    (): SnapshotTiming | undefined => readSnapshotTiming(api),
    [api],
  );
  const firstLineProbe = useCallback(() => readFirstLineProbe(api), [api]);
  const memoryProbe = useCallback(() => readMemoryProbe(), []);
  const layoutInfo = useCallback((): Promise<SplitLayoutInfo> => readSplitLayoutInfo(api), [api]);

  const splitActiveView = useCallback(
    (edge: "left" | "right" | "top" | "bottom" = "right", mode: "copy" | "move" = "copy") => {
      const state = api.getState();
      const groups = Object.values(state.layout.groups);
      const owner = groups.find((group) =>
        group.views.some((view) => view.bufferId === state.activeId),
      );
      const view = owner?.views.find((candidate) => candidate.bufferId === state.activeId);
      if (owner && view) api.getState().splitViewToEdge(view.id, owner.id, edge, mode);
    },
    [api],
  );

  const closeGroup = useCallback(
    (groupId: string) => {
      api.getState().closeGroup(groupId);
    },
    [api],
  );

  // 只重挂载 GroupPane 子树；Store 与 Monaco 模型注册表都保留，用来验证同一
  // model 重建后保存基线 / 撤销历史仍然有效。
  const [editorEpoch, setEditorEpoch] = useState(0);
  const remountEditors = useCallback(() => setEditorEpoch((value) => value + 1), []);

  const installModelCounters = useCallback(async (): Promise<boolean> => {
    const monaco = await import("monaco-editor");
    const models = monaco.editor.getModels();
    for (const model of models) {
      installPrototypeCounters(Object.getPrototypeOf(model));
    }
    installStorageCounters();
    installIdbCounters();
    return models.length > 0;
  }, []);

  const beginMeasure = useCallback(() => {
    startMeasureCounters();
  }, []);

  const readMeasure = useCallback(
    (stop: boolean): TypingMeasure | undefined => {
      const counters = snapshotProbeCounters();
      if (stop) stopMeasureCounters();
      const quick = quickTextState();
      if (!quick) return undefined;
      return {
        ...quick,
        counters,
        localSessionRawLength: (window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "").length,
      };
    },
    [quickTextState],
  );

  const endMeasure = useCallback((): TypingMeasure | undefined => readMeasure(true), [readMeasure]);
  const readMeasureWhileActive = useCallback(
    (): TypingMeasure | undefined => readMeasure(false),
    [readMeasure],
  );

  const beginKeypressMetrics = useCallback(async (): Promise<boolean> => {
    if (keypressMetricsRef.current) return true;
    const { model } = await activeEditorFor(api);
    if (!model) return false;
    const metrics: KeypressMetricsState = {
      records: [],
      modelChanges: 0,
      storeChanges: 0,
      onKeydown: () => {
        metrics.records.push({ down: performance.now() });
      },
      modelSubscription: { dispose: () => undefined },
      storeUnsubscribe: () => undefined,
    };
    window.addEventListener("keydown", metrics.onKeydown, true);
    metrics.modelSubscription = model.onDidChangeContent(() => {
      metrics.modelChanges += 1;
      const at = performance.now();
      for (let index = metrics.records.length - 1; index >= 0; index -= 1) {
        const record = metrics.records[index]!;
        if (record.model === undefined) {
          record.model = at;
          break;
        }
      }
    });
    metrics.storeUnsubscribe = api.subscribe((next, previous) => {
      if (next.textChangeEpoch === previous.textChangeEpoch) return;
      metrics.storeChanges += 1;
      const at = performance.now();
      for (let index = metrics.records.length - 1; index >= 0; index -= 1) {
        const record = metrics.records[index]!;
        if (record.store === undefined) {
          record.store = at;
          break;
        }
      }
    });
    keypressMetricsRef.current = metrics;
    return true;
  }, [api]);

  const endKeypressMetrics = useCallback((): KeypressMetricSummary | undefined => {
    const metrics = keypressMetricsRef.current;
    if (!metrics) return undefined;
    keypressMetricsRef.current = null;
    window.removeEventListener("keydown", metrics.onKeydown, true);
    metrics.modelSubscription.dispose();
    metrics.storeUnsubscribe();
    return summarizeKeypressMetrics(metrics);
  }, []);

  const resetModels = useCallback(async () => {
    const metrics = keypressMetricsRef.current;
    if (metrics) {
      window.removeEventListener("keydown", metrics.onKeydown, true);
      metrics.modelSubscription.dispose();
      metrics.storeUnsubscribe();
      keypressMetricsRef.current = null;
    }
    const monaco = await import("monaco-editor");
    for (const model of monaco.editor.getModels()) {
      if (!model.isDisposed()) model.dispose();
    }
  }, []);

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
      modelSummary,
      focusEditor,
      bufferTokens,
      saveActive,
      persistNow: persistence.persist,
      sessionInfo: readSessionInfo,
      draftRecords: readDraftRecords,
      draftParts: readDraftParts,
      installModelCounters,
      beginMeasure,
      endMeasure,
      readMeasure: readMeasureWhileActive,
      beginKeypressMetrics,
      endKeypressMetrics,
      quickState: quickTextState,
      timeSnapshot,
      firstLineProbe,
      memoryProbe,
      layoutInfo,
      splitActiveView,
      closeGroup,
      remountEditors,
      resetModels,
      saveEvents: saveEventsRef.current,
      logs: window.__fullTextE2E?.logs ?? [],
      toasts: window.__fullTextE2E?.toasts ?? [],
    });
  }, [
    beginKeypressMetrics,
    beginMeasure,
    bufferTokens,
    closeGroup,
    editorSnapshot,
    endKeypressMetrics,
    endMeasure,
    firstLineProbe,
    focusEditor,
    goToLine,
    installModelCounters,
    layoutInfo,
    memoryProbe,
    modelSummary,
    monacoInfo,
    openExistingPath,
    persistence.persist,
    quickTextState,
    readMeasureWhileActive,
    remountEditors,
    resetModels,
    saveActive,
    snapshot,
    splitActiveView,
    timeSnapshot,
  ]);

  const groupIds = useMemo(() => listGroupIds(layout.root), [layout.root]);

  return (
    <div className="files-e2e-app" data-files-e2e-ready="true" data-files-e2e-mode={mode}>
      {groupIds.map((groupId) => {
        const group = layout.groups[groupId];
        if (!group) return null;
        const focused = layout.focusedGroupId === groupId;
        return (
          <div
            key={`${groupId}:${editorEpoch}`}
            className="files-e2e-pane"
            data-files-e2e-group-host={groupId}
          >
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
              onAttachTextDocument={api.getState().attachTextDocument}
              onDetachTextDocument={api.getState().detachTextDocument}
              onTextDocumentChange={api.getState().noteTextDocumentChange}
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
