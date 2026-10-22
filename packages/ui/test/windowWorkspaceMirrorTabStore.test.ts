import assert from "node:assert/strict";
import test from "node:test";
import {
  createTabStore,
  isWorkspaceTab,
  type TabStoreCommandSink,
} from "../src/store/tabStore.js";
function createRecordingSink() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };
  const sink: TabStoreCommandSink = {
    openWorkspace: (workspacePath, options) =>
      record("openWorkspace", workspacePath, options),
    ensureWorkspace: (workspacePath, options) =>
      record("ensureWorkspace", workspacePath, options),
    closeWorkspace: (tabId) => record("closeWorkspace", tabId),
    activateWorkspace: (tabId) => record("activateWorkspace", tabId),
    reorderWorkspaces: (fromIndex, toIndex) =>
      record("reorderWorkspaces", fromIndex, toIndex),
    setWorkspaceExpanded: (workspacePath, expanded) =>
      record("setWorkspaceExpanded", workspacePath, expanded),
  };
  return { calls, sink };
}

test("镜像端安装命令通道后，结构操作转交权威端而不改本地状态", () => {
  const store = createTabStore(null);
  const { calls, sink } = createRecordingSink();
  store.getState().setCommandSink(sink);

  store.getState().addTab("/repo/alpha");
  store.getState().ensureWorkspaceTab("/repo/beta");
  store.getState().activateTab("tab-1");
  store.getState().closeTab("tab-1");
  store.getState().reorderWorkspaceTabs(0, 1);

  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "openWorkspace",
      "ensureWorkspace",
      "activateWorkspace",
      "closeWorkspace",
      "reorderWorkspaces",
    ],
  );
  assert.deepEqual(calls[0]!.args[0], "/repo/alpha");
  // 本地集合保持为空：镜像端不自持窗口结构。
  assert.equal(store.getState().tabs.length, 0);
});

test("镜像端展开态取自权威端快照，切换时按快照算出下一个展开态", () => {
  const store = createTabStore(null);
  const { calls, sink } = createRecordingSink();
  store.getState().applyMirroredWorkspaceSet({
    revision: 1,
    entries: [{ id: "tab-a", workspacePath: "/repo/alpha" }],
    activeEntryId: "tab-a",
    activeWorkspacePath: "/repo/alpha",
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: ["/repo/alpha"],
  });
  store.getState().setCommandSink(sink);

  store.getState().toggleWorkspaceExpanded("/repo/alpha");

  assert.deepEqual(calls[0]!.name, "setWorkspaceExpanded");
  assert.deepEqual(calls[0]!.args, ["/repo/alpha", false]);
  // 切换本身不改本地展开态：展开态只由权威端快照决定。
  assert.deepEqual(
    [...store.getState().expandedWorkspacePaths],
    ["/repo/alpha"],
  );
});

test("命令通道被移除后恢复自持行为", () => {
  const store = createTabStore(null);
  const { sink } = createRecordingSink();
  store.getState().setCommandSink(sink);
  store.getState().setCommandSink(null);

  store.getState().addTab("/repo/gamma");

  assert.equal(store.getState().tabs.length, 1);
  assert.equal(isWorkspaceTab(store.getState().tabs[0]!), true);
  assert.equal(
    (store.getState().tabs[0] as { workspacePath: string }).workspacePath,
    "/repo/gamma",
  );
});

test("应用镜像快照后集合、顺序、激活项与展开态都以快照为准", () => {
  const store = createTabStore(null);
  store.getState().applyMirroredWorkspaceSet({
    revision: 1,
    entries: [
      { id: "tab-a", workspacePath: "/repo/alpha" },
      { id: "tab-b", workspacePath: "/repo/beta" },
    ],
    activeEntryId: "tab-b",
    activeWorkspacePath: "/repo/beta",
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: ["/repo/alpha"],
  });

  const state = store.getState();
  assert.equal(state.tabs.length, 2);
  assert.deepEqual(
    state.tabs.filter(isWorkspaceTab).map((tab) => tab.id),
    ["tab-a", "tab-b"],
  );
  assert.equal(state.activeTabId, "tab-b");
  assert.equal(state.activeWorkspacePath, "/repo/beta");
  assert.deepEqual([...state.expandedWorkspacePaths], ["/repo/alpha"]);
});

test("重复应用同一份镜像快照是幂等的", () => {
  const store = createTabStore(null);
  const mirrored = {
    revision: 1,
    entries: [{ id: "tab-a", workspacePath: "/repo/alpha" }],
    activeEntryId: "tab-a",
    activeWorkspacePath: "/repo/alpha",
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: ["/repo/alpha"],
  };

  store.getState().applyMirroredWorkspaceSet(mirrored);
  const first = store.getState().tabs.map((tab) => tab.id);
  store.getState().applyMirroredWorkspaceSet(mirrored);
  const second = store.getState().tabs.map((tab) => tab.id);

  assert.deepEqual(second, first);
});

test("镜像快照保留本端设置页与文件页外壳标签", () => {
  const store = createTabStore(null);
  store.getState().addTab("/repo/local");

  store.getState().applyMirroredWorkspaceSet({
    revision: 1,
    entries: [{ id: "tab-a", workspacePath: "/repo/alpha" }],
    activeEntryId: "tab-a",
    activeWorkspacePath: "/repo/alpha",
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: [],
  });

  const workspaceTabs = store.getState().tabs.filter(isWorkspaceTab);
  assert.deepEqual(
    workspaceTabs.map((tab) => tab.workspacePath),
    ["/repo/alpha"],
  );
});
