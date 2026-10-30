import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// 使用生产全局样式，让标签条/隐藏状态依赖的真实 Tailwind 工具类生效。
import "../../../src/styles.css";
import "./fixture.css";

import { FilesEditorGroupPane } from "@/files-workbench/FilesEditorGroupPane.js";
import {
  FilesEditorStoreProvider,
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";
import {
  createLargeTextFileBuffer,
  createTextFileBuffer,
  filesBufferTabTitle,
  isFilesBufferDirty,
} from "@/files-workbench/filesEditorModel.js";
import type {
  FilesBuffer,
  FilesEditorState,
  FilesWorkspaceRef,
} from "@/files-workbench/filesEditorTypes.js";
import type { FilesEditorLayoutNode } from "@/files-workbench/filesEditorLayout.js";
import type { FilesEditorStatusHandle } from "@/files-workbench/filesMonacoStatusHandle.js";
import { getFixtureLocale, setFixtureLocale } from "./stubs/intl.js";

/**
 * 隔离夹具入口：挂载真实 FilesEditorGroupPane + 真实 filesEditorStore。
 *
 * 只替换 Host/服务边界（i18n、settings、toast、logger、应用级 store、Monaco 外壳、
 * 非 Markdown 预览、大文本查看器）。标签条、按视图状态、预览切换、Markdown 渲染
 * 全部走生产源码；切换逻辑不在夹具里重写。
 */

type Scenario = "markdown" | "split" | "mixed" | "many" | "split-many" | "large";

const WORKSPACE: FilesWorkspaceRef = {
  workspacePath: "/workspace/demo",
  workspaceIdentity: "ws-demo",
};

const MD_PATH = "/workspace/demo/docs/guide.md";
const TS_PATH = "/workspace/demo/src/app.ts";
const TXT_PATH = "/workspace/demo/notes.txt";
const README_PATH = "/workspace/demo/README.md";
const LARGE_PATH = "/workspace/demo/huge.md";

const MD_SAVED = "# Guide\n\nSAVED-BODY";
const TS_SAVED = "export const answer = 42;\n";
const TXT_SAVED = "plain text notes\n";
const README_SAVED = "# Demo\n\nREADME-BODY";

type SaveCall = {
  bufferId: string;
  text: string;
  savedText: string;
};

type EditorHandleEvent = {
  groupId: string;
  bufferId?: string;
  handleId: number | null;
};

type ViewSnapshot = {
  groupId: string;
  viewId: string;
  bufferId: string;
  active: boolean;
  focused: boolean;
};

type BufferSnapshot = {
  id: string;
  kind: FilesBuffer["kind"];
  path?: string;
  title: string;
  text?: string;
  savedText?: string;
  dirty: boolean;
};

type Snapshot = {
  focusedGroupId: string;
  groups: Array<{
    id: string;
    activeViewId?: string;
    views: Array<{ id: string; bufferId: string }>;
  }>;
  views: ViewSnapshot[];
  buffers: BufferSnapshot[];
  saveCalls: SaveCall[];
  editorHandleEvents: EditorHandleEvent[];
};

type FilesE2EProbe = {
  mount: (scenario: Scenario) => void;
  snapshot: () => Snapshot;
  viewIdForPath: (path: string) => string | undefined;
  groupIdForPath: (path: string) => string | undefined;
  sourceModelValue: (bufferId: string) => string | undefined;
  setLocale: (locale: "zh-CN" | "en-US") => void;
  locale: () => string;
  saveCalls: SaveCall[];
  logs: string[];
  toasts: string[];
};

declare global {
  interface Window {
    __filesE2E?: Partial<FilesE2EProbe> & Record<string, unknown> & { saveCalls: SaveCall[] };
  }
}

function listGroupIds(node: FilesEditorLayoutNode): string[] {
  if (node.type === "leaf") return [node.groupId];
  return [...listGroupIds(node.children[0]), ...listGroupIds(node.children[1])];
}

function bufferForPath(state: FilesEditorState, path: string): FilesBuffer | undefined {
  return state.buffers.find((buffer) => buffer.path === path);
}

function Workbench({ scenario }: { scenario: Scenario }) {
  const api = useFilesEditorStoreApi();
  const layout = useFilesEditorStore((state) => state.layout);
  const buffers = useFilesEditorStore((state) => state.buffers);
  const [ready, setReady] = useState(false);
  const saveCallsRef = useRef<SaveCall[]>([]);
  saveCallsRef.current = saveCallsRef.current ?? [];
  const saveCalls = saveCallsRef.current;
  // 记录 GroupPane 上报的编辑器句柄；WeakMap 只用于给不可序列化的句柄编号。
  const handleEventsRef = useRef<EditorHandleEvent[]>([]);
  const handleIdsRef = useRef(new WeakMap<object, number>());
  const nextHandleIdRef = useRef(1);
  const onEditorHandleChange = useCallback(
    (groupId: string, handle: FilesEditorStatusHandle | null, bufferId?: string) => {
      let handleId: number | null = null;
      if (handle) {
        const ids = handleIdsRef.current;
        handleId = ids.get(handle) ?? nextHandleIdRef.current++;
        ids.set(handle, handleId);
      }
      handleEventsRef.current.push({ groupId, bufferId, handleId });
    },
    [],
  );

  useLayoutEffect(() => {
    const state = api.getState();
    const md = createTextFileBuffer({ workspace: WORKSPACE, path: MD_PATH, text: MD_SAVED });
    state.openBuffer(md);
    const openText = (path: string, text: string) =>
      api.getState().openBuffer(createTextFileBuffer({ workspace: WORKSPACE, path, text }));
    // 横滚回归的起点固定在左侧首 tab，测试再用页面内 DOM click 激活末尾 tab。
    const activateLargestGroupView = (index: number) => {
      const opened = api.getState();
      const group = Object.values(opened.layout.groups).sort(
        (left, right) => right.views.length - left.views.length,
      )[0];
      const view = group?.views[index];
      if (view) opened.activateView(view.id);
    };
    if (scenario === "split") {
      const opened = api.getState();
      const groupId = opened.layout.focusedGroupId;
      const viewId = opened.layout.groups[groupId]?.activeViewId;
      if (groupId && viewId) {
        api.getState().splitViewToEdge(viewId, groupId, "right", "copy");
      }
    } else if (scenario === "mixed") {
      openText(TS_PATH, TS_SAVED);
      openText(TXT_PATH, TXT_SAVED);
    } else if (scenario === "many") {
      openText(TS_PATH, TS_SAVED);
      openText(TXT_PATH, TXT_SAVED);
      openText(README_PATH, README_SAVED);
      activateLargestGroupView(0);
    } else if (scenario === "split-many") {
      openText(TS_PATH, TS_SAVED);
      openText(TXT_PATH, TXT_SAVED);
      const opened = api.getState();
      const groupId = opened.layout.focusedGroupId;
      const viewId = opened.layout.groups[groupId]?.activeViewId;
      if (groupId && viewId) {
        api.getState().splitViewToEdge(viewId, groupId, "right", "copy");
      }
      activateLargestGroupView(0);
    } else if (scenario === "large") {
      api.getState().openBuffer(
        createLargeTextFileBuffer({
          workspace: WORKSPACE,
          path: LARGE_PATH,
          totalBytes: 9 * 1024 * 1024,
        }),
      );
    }
    setReady(true);
  }, [api, scenario]);

  useLayoutEffect(() => {
    const probe: Partial<FilesE2EProbe> = {
      snapshot: () => {
        const state = api.getState();
        const groupIds = listGroupIds(state.layout.root);
        return {
          focusedGroupId: state.layout.focusedGroupId,
          groups: groupIds.map((groupId) => {
            const group = state.layout.groups[groupId]!;
            return {
              id: group.id,
              activeViewId: group.activeViewId,
              views: group.views.map((view) => ({
                id: view.id,
                bufferId: view.bufferId,
              })),
            };
          }),
          views: groupIds.flatMap((groupId) => {
            const group = state.layout.groups[groupId]!;
            return group.views.map((view) => ({
              groupId,
              viewId: view.id,
              bufferId: view.bufferId,
              active: group.activeViewId === view.id,
              focused: state.layout.focusedGroupId === groupId,
            }));
          }),
          buffers: state.buffers.map((buffer) => ({
            id: buffer.id,
            kind: buffer.kind,
            path: buffer.path,
            title: filesBufferTabTitle(buffer),
            text: "text" in buffer ? buffer.text : undefined,
            savedText: "savedText" in buffer ? buffer.savedText : undefined,
            dirty: isFilesBufferDirty(buffer),
          })),
          saveCalls: [...saveCalls],
          editorHandleEvents: [...handleEventsRef.current],
        };
      },
      viewIdForPath: (path: string) => {
        const state = api.getState();
        const buffer = bufferForPath(state, path);
        if (!buffer) return undefined;
        for (const group of Object.values(state.layout.groups)) {
          const view = group.views.find((candidate) => candidate.bufferId === buffer.id);
          if (view) return view.id;
        }
        return undefined;
      },
      groupIdForPath: (path: string) => {
        const state = api.getState();
        const buffer = bufferForPath(state, path);
        if (!buffer) return undefined;
        for (const group of Object.values(state.layout.groups)) {
          if (group.views.some((view) => view.bufferId === buffer.id)) return group.id;
        }
        return undefined;
      },
      saveCalls,
    };
    Object.assign(window.__filesE2E!, probe);
  }, [api, saveCalls]);

  const onSave = useCallback(
    (bufferId: string) => {
      const state = api.getState();
      const buffer = state.buffers.find((candidate) => candidate.id === bufferId);
      if (!buffer || buffer.kind !== "text" || !buffer.path) return;
      saveCalls.push({ bufferId, text: buffer.text, savedText: buffer.savedText });
      state.markSaved(bufferId, {
        path: buffer.path,
        text: buffer.text,
        workspace: buffer.workspace,
      });
    },
    [api, saveCalls],
  );

  const groupIds = useMemo(() => listGroupIds(layout.root), [layout.root]);

  if (!ready) return null;

  return (
    <div className="files-e2e-app" data-files-e2e-ready="true" data-scenario={scenario}>
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
              loadRestoredTextFile={async () => {}}
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
              onSplit={(viewId, targetGroupId, edge, mode) =>
                api.getState().splitViewToEdge(viewId, targetGroupId, edge, mode)
              }
              onChange={(bufferId, text) => api.getState().updateText(bufferId, text)}
              onOpenPath={() => false}
              onRevealPositionApplied={() => {}}
              focusRequest={undefined}
              onFocusApplied={() => {}}
              onCreateUntitled={() => api.getState().createUntitled(WORKSPACE)}
              onSave={onSave}
              onSaveAs={() => {}}
              onSetMarkdownViewMode={(viewId, mode) =>
                api.getState().setViewMarkdownViewMode(viewId, mode)
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
  const [request, setRequest] = useState<{ key: number; scenario: Scenario } | null>(null);
  const keyRef = useRef(0);

  useLayoutEffect(() => {
    window.__filesE2E ??= { saveCalls: [], logs: [], toasts: [] };
    window.__filesE2E.saveCalls = [];
    window.__filesE2E.logs = [];
    window.__filesE2E.toasts = [];
    window.__filesE2E.setLocale = (locale) => setFixtureLocale(locale);
    window.__filesE2E.locale = () => getFixtureLocale();
    window.__filesE2E.mount = (scenario: Scenario) => {
      keyRef.current += 1;
      setRequest({ key: keyRef.current, scenario });
    };
  }, []);

  if (!request) return null;
  return (
    <FilesEditorStoreProvider key={request.key}>
      <Workbench scenario={request.scenario} />
    </FilesEditorStoreProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root");
createRoot(rootElement).render(<App />);
