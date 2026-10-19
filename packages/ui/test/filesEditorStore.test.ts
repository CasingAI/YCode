import assert from "node:assert/strict";
import test from "node:test";
import { filesFileBufferId } from "../src/files-workbench/filesEditorModel.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";
import type {
  FilesPersistedSession,
  FilesWorkspaceRef,
} from "../src/files-workbench/filesEditorTypes.js";

const workspace: FilesWorkspaceRef = { workspacePath: "/workspace" };

test("hydrating a persisted session restores tab metadata without file contents", () => {
  const cleanId = filesFileBufferId(workspace, "/workspace/src/app.ts");
  const previewId = filesFileBufferId(workspace, "/workspace/assets/logo.png");
  const dirtyId = filesFileBufferId(workspace, "/workspace/README.md");
  const session: FilesPersistedSession = {
    version: 1,
    activeId: cleanId,
    openFileIds: [dirtyId, cleanId, previewId],
    openTabs: [
      { id: dirtyId, kind: "text", path: "/workspace/README.md", workspace },
      { id: cleanId, kind: "text", path: "/workspace/src/app.ts", workspace },
      {
        id: previewId,
        kind: "preview",
        path: "/workspace/assets/logo.png",
        workspace,
        preview: true,
      },
    ],
    drafts: [
      {
        id: dirtyId,
        path: "/workspace/README.md",
        title: "README.md",
        text: "unsaved",
        savedText: "saved",
        workspace,
        untitled: false,
      },
    ],
  };

  const store = createFilesEditorStore();
  store.getState().hydrateSession(session);
  const state = store.getState();

  assert.deepEqual(state.openIds, [dirtyId, cleanId, previewId]);
  assert.equal(state.activeId, cleanId);
  assert.deepEqual(
    state.buffers.map((buffer) => buffer.id),
    [dirtyId, cleanId, previewId],
  );
  assert.equal(state.buffers[0]?.kind === "text" ? state.buffers[0].text : undefined, "unsaved");
  assert.equal(
    state.buffers[1]?.kind === "text" ? state.buffers[1].loadState : undefined,
    "unloaded",
  );
  assert.equal(state.buffers[1]?.kind === "text" ? state.buffers[1].text : undefined, "");
  assert.equal(state.buffers[2]?.kind === "preview" ? state.buffers[2].preview : undefined, true);
});

test("loading restored text sets the disk baseline and keeps the preview tab state", () => {
  const previewId = filesFileBufferId(workspace, "/workspace/src/app.ts");
  const store = createFilesEditorStore();
  store.getState().hydrateSession({
    version: 1,
    activeId: previewId,
    openFileIds: [previewId],
    openTabs: [
      { id: previewId, kind: "text", path: "/workspace/src/app.ts", workspace, preview: true },
    ],
    drafts: [],
  });

  store.getState().setTextLoadState(previewId, "loading");
  store.getState().restoreTextContent(previewId, { text: "disk contents", truncated: false });

  const buffer = store.getState().buffers[0];
  assert.equal(buffer?.kind === "text" ? buffer.text : undefined, "disk contents");
  assert.equal(buffer?.kind === "text" ? buffer.savedText : undefined, "disk contents");
  assert.equal(buffer?.kind === "text" ? buffer.loadState : undefined, undefined);
  assert.equal(buffer?.kind === "text" ? buffer.preview : undefined, true);
});

test("打开缓冲时在当前编辑器组建立视图，恢复会重建单组布局", () => {
  const store = createFilesEditorStore();
  const first = {
    id: filesFileBufferId(workspace, "/workspace/a.ts"),
    kind: "text" as const,
    untitled: false,
    path: "/workspace/a.ts",
    title: "a.ts",
    text: "a",
    savedText: "a",
    workspace,
  };
  const second = {
    ...first,
    id: filesFileBufferId(workspace, "/workspace/b.ts"),
    path: "/workspace/b.ts",
    title: "b.ts",
    text: "b",
    savedText: "b",
  };
  store.getState().openBuffer(first);
  store.getState().openBuffer(second);
  let state = store.getState();
  const group = state.layout.groups[state.layout.focusedGroupId];
  assert.deepEqual(
    group?.views.map((view) => view.bufferId),
    [first.id, second.id],
  );
  assert.equal(group?.views.find((view) => view.id === group.activeViewId)?.bufferId, second.id);
  assert.equal(state.activeId, second.id);

  const session = state.snapshotSession();
  store.getState().hydrateSession(session);
  state = store.getState();
  assert.equal(Object.keys(state.layout.groups).length, 1);
  assert.deepEqual(
    state.layout.groups[state.layout.focusedGroupId]?.views.map((view) => view.bufferId),
    [first.id, second.id],
  );
});

test("同一缓冲可以分屏显示且编辑状态共享，关闭单个视图不会关闭缓冲", () => {
  const store = createFilesEditorStore();
  const buffer = {
    id: filesFileBufferId(workspace, "/workspace/shared.ts"),
    kind: "text" as const,
    untitled: false,
    path: "/workspace/shared.ts",
    title: "shared.ts",
    text: "before",
    savedText: "before",
    workspace,
  };
  store.getState().openBuffer(buffer);
  const firstLayout = store.getState().layout;
  const firstView = firstLayout.groups[firstLayout.focusedGroupId]?.views[0];
  assert.ok(firstView);
  store.getState().splitViewToEdge(firstView.id, firstLayout.focusedGroupId, "right", "copy");

  let state = store.getState();
  assert.equal(Object.keys(state.layout.groups).length, 2);
  const views = Object.values(state.layout.groups).flatMap((group) => group.views);
  assert.equal(views.length, 2);
  assert.deepEqual(
    views.map((view) => view.bufferId),
    [buffer.id, buffer.id],
  );
  assert.notEqual(views[0]?.id, views[1]?.id);

  store.getState().updateText(buffer.id, "after");
  assert.equal(
    store.getState().buffers.find((item) => item.id === buffer.id)?.kind === "text"
      ? store.getState().buffers.find((item) => item.id === buffer.id)?.text
      : undefined,
    "after",
  );
  store.getState().removeView(views[0]!.id);
  state = store.getState();
  assert.equal(Object.values(state.layout.groups).flatMap((group) => group.views).length, 1);
  assert.equal(
    state.buffers.some((item) => item.id === buffer.id),
    true,
  );
  assert.deepEqual(state.openIds, [buffer.id]);
});

test("关闭缓冲会清理所有视图并保留可继续打开文件的根组", () => {
  const store = createFilesEditorStore();
  const buffer = {
    id: filesFileBufferId(workspace, "/workspace/close.ts"),
    kind: "text" as const,
    untitled: false,
    path: "/workspace/close.ts",
    title: "close.ts",
    text: "x",
    savedText: "x",
    workspace,
  };
  store.getState().openBuffer(buffer);
  const state = store.getState();
  const view = state.layout.groups[state.layout.focusedGroupId]?.views[0];
  assert.ok(view);
  store.getState().splitViewToEdge(view.id, state.layout.focusedGroupId, "bottom", "copy");
  store.getState().closeBuffer(buffer.id);
  const closed = store.getState();
  assert.deepEqual(closed.openIds, []);
  assert.equal(
    closed.buffers.some((item) => item.id === buffer.id),
    false,
  );
  assert.equal(Object.values(closed.layout.groups).flatMap((group) => group.views).length, 0);
  assert.equal(Object.keys(closed.layout.groups).length, 1);
});

test("各编辑器组独立记忆活动视图，关闭组只移除该组视图", () => {
  const store = createFilesEditorStore();
  const makeBuffer = (path: string) => ({
    id: filesFileBufferId(workspace, path),
    kind: "text" as const,
    untitled: false,
    path,
    title: path.split("/").at(-1) ?? path,
    text: path,
    savedText: path,
    workspace,
  });
  const first = makeBuffer("/workspace/first.ts");
  const second = makeBuffer("/workspace/second.ts");
  store.getState().openBuffer(first);
  store.getState().openBuffer(second);
  const firstLayout = store.getState().layout;
  const sourceGroupId = firstLayout.focusedGroupId;
  const sourceViews = firstLayout.groups[sourceGroupId]!.views;
  const secondView = sourceViews.find((view) => view.bufferId === second.id)!;
  store.getState().splitViewToEdge(secondView.id, sourceGroupId, "right", "copy");

  let state = store.getState();
  const targetGroupId = state.layout.focusedGroupId;
  const copiedView = state.layout.groups[targetGroupId]!.views[0]!;
  store.getState().activateView(sourceViews.find((view) => view.bufferId === first.id)!.id);
  state = store.getState();
  assert.equal(
    state.layout.groups[sourceGroupId]?.activeViewId,
    sourceViews.find((view) => view.bufferId === first.id)!.id,
  );
  assert.equal(state.layout.groups[targetGroupId]?.activeViewId, copiedView.id);
  assert.equal(state.activeId, first.id);

  store.getState().closeGroup(targetGroupId);
  state = store.getState();
  assert.equal(state.layout.groups[targetGroupId], undefined);
  assert.equal(Object.keys(state.layout.groups).length, 1);
  assert.equal(
    state.buffers.some((buffer) => buffer.id === second.id),
    true,
  );
  assert.equal(
    state.layout.groups[sourceGroupId]?.views.some((view) => view.bufferId === second.id),
    true,
  );
});

test("连续的系统文件打开请求按顺序排队，不会覆盖尚未处理的文件", () => {
  const store = createFilesEditorStore();
  const first = { workspace, path: "/workspace/first.ts" };
  const second = { workspace, path: "/workspace/second.pdf" };
  const third = { workspace, path: "/workspace/third.docx" };
  store.getState().requestOpenPath(first);
  store.getState().requestOpenPath(second);
  store.getState().requestOpenPath(third);

  assert.equal(store.getState().pendingOpen?.path, first.path);
  assert.deepEqual(
    store.getState().pendingOpenQueue?.map((item) => item.path),
    [first.path, second.path, third.path],
  );
  store.getState().clearPendingOpen();
  assert.equal(store.getState().pendingOpen?.path, second.path);
  store.getState().clearPendingOpen();
  assert.equal(store.getState().pendingOpen?.path, third.path);
  store.getState().clearPendingOpen();
  assert.equal(store.getState().pendingOpen, undefined);
  assert.equal(store.getState().pendingOpenQueue, undefined);
});

test("pending open requests have a single in-flight owner and advance only after completion", () => {
  const store = createFilesEditorStore();
  store.getState().requestOpenPath({ workspace, path: "/workspace/first.ts" });
  store.getState().requestOpenPath({ workspace, path: "/workspace/second.ts" });
  const first = store.getState().pendingOpen!;

  assert.equal(store.getState().beginPendingOpen(first), true);
  assert.equal(store.getState().beginPendingOpen(first), false);
  assert.equal(store.getState().pendingOpen?.path, "/workspace/first.ts");
  store.getState().completePendingOpen(first);
  assert.equal(store.getState().pendingOpen?.path, "/workspace/second.ts");
  assert.equal(store.getState().pendingOpenInFlight, undefined);
  const second = store.getState().pendingOpen!;
  assert.equal(store.getState().beginPendingOpen(second), true);
  store.getState().completePendingOpen(second);
  assert.equal(store.getState().pendingOpen, undefined);
});

test("hydrating duplicate persisted IDs creates only one buffer and one editor view", () => {
  const id = filesFileBufferId(workspace, "/workspace/duplicate.ts");
  const tab = { id, kind: "text" as const, path: "/workspace/duplicate.ts", workspace };
  const store = createFilesEditorStore();
  store.getState().hydrateSession({
    version: 1,
    activeId: id,
    openFileIds: Array.from({ length: 103 }, () => id),
    openTabs: Array.from({ length: 103 }, () => tab),
    drafts: [],
  });

  const state = store.getState();
  assert.deepEqual(state.openIds, [id]);
  assert.equal(state.buffers.length, 1);
  assert.equal(Object.values(state.layout.groups).flatMap((group) => group.views).length, 1);
  assert.equal(state.activeId, id);
});

test("批量关闭其他标签只触发一次 Store 更新，并保留目标标签", () => {
  const store = createFilesEditorStore();
  const makeBuffer = (name: string) => ({
    id: filesFileBufferId(workspace, `/workspace/${name}.ts`),
    kind: "text" as const,
    untitled: false,
    path: `/workspace/${name}.ts`,
    title: `${name}.ts`,
    text: name,
    savedText: name,
    workspace,
  });
  const keep = makeBuffer("keep");
  const closeA = makeBuffer("close-a");
  const closeB = makeBuffer("close-b");
  store.getState().openBuffer(keep);
  store.getState().openBuffer(closeA);
  store.getState().openBuffer(closeB);
  const before = store.getState();
  const group = before.layout.groups[before.layout.focusedGroupId]!;
  const keepView = group.views.find((view) => view.bufferId === keep.id)!;
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  store.getState().closeViewsAndBuffers({
    viewIdsToRemove: [],
    bufferIdsToClose: [closeA.id, closeB.id],
  });
  unsubscribe();

  const after = store.getState();
  assert.equal(notifications, 1);
  assert.deepEqual(after.openIds, [keep.id]);
  assert.deepEqual(
    after.buffers.map((buffer) => buffer.id),
    [keep.id],
  );
  assert.deepEqual(
    after.layout.groups[after.layout.focusedGroupId]?.views.map((view) => view.bufferId),
    [keep.id],
  );
  assert.ok(keepView);
});
