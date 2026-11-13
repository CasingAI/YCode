import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBrowserUseSidePaneEvent,
  applyBrowserUseSidePaneVisibilityEvent,
  closeSidePaneTab,
  getVisibleSidePaneTabs,
  isSidePaneTabVisibleForParent,
  markBrowserUseSidePaneTabOperation,
  openSubagentSessionSidePane,
  setActiveSidePaneTab,
  stampBrowserUseViewerAttribution,
  syncSubagentSessionSidePaneTabs,
  type BrowserUseSidePaneTab,
  type WorkspaceSidePaneState,
} from "../src/lib/workspaceSidePane.js";

// 子代理 own-tabs 回归（docs/specs/subagent-browser-use-delegation.md 验收 12/13、16-22）：
// child session 的 ready 事件只能在其 origin workspace/session 被查看时展开；
// 父会话或其他 workspace 只后台挂载 guest，不切换 activeTab，也不抢焦点。
//
// 查看归属只来自根会话 conversation 投影 `snapshot.subagents`（经 SessionPane 同步通路），
// 并冻结到 browser-use tab 的 viewerRootSessionId/viewerTitle 上；不以临时 subagent-session
// tab 是否存在为前提。用纯状态函数和 fakes，不连接 YCode、不启动浏览器。

const WORKSPACE_KEY = "ws-1";
const PARENT_ID = "sess_parent";
const CHILD_ID = "sess_child";
const CHILD_TAB_ID = "browser-use:tab-child";

function parentState(): WorkspaceSidePaneState {
  const tab: BrowserUseSidePaneTab = {
    id: "browser-use:tab-parent",
    type: "browser-use",
    sessionId: PARENT_ID,
    ownerTaskId: PARENT_ID,
    workspaceKey: WORKSPACE_KEY,
    tabId: "tab-parent",
    title: "Parent page",
  };
  return { tabs: [tab], activeTabId: tab.id };
}

function childBrowserTab(overrides: Partial<BrowserUseSidePaneTab> = {}): BrowserUseSidePaneTab {
  return {
    id: CHILD_TAB_ID,
    type: "browser-use",
    sessionId: CHILD_ID,
    ownerTaskId: CHILD_ID,
    workspaceKey: WORKSPACE_KEY,
    tabId: "tab-child",
    title: "Child page",
    ...overrides,
  };
}

function childEvent(overrides: Partial<{ sessionId: string; workspaceKey: string }> = {}) {
  return {
    workspaceKey: WORKSPACE_KEY,
    sessionId: CHILD_ID,
    tabId: "tab-child",
    browserId: "iab-1",
    browserGeneration: 2,
    ...overrides,
  };
}

const PARENT_SCOPE = {
  workspaceKey: WORKSPACE_KEY,
  ownerTaskId: PARENT_ID,
  remoteSessionId: undefined,
};

function visibleIds(state: WorkspaceSidePaneState | null): string[] {
  return state ? getVisibleSidePaneTabs(state.tabs, PARENT_SCOPE).map((tab) => tab.id) : [];
}

function readyChild(current: WorkspaceSidePaneState): WorkspaceSidePaneState {
  return applyBrowserUseSidePaneEvent(current, childEvent(), {
    workspaceKey: WORKSPACE_KEY,
    ownerTaskId: PARENT_ID,
  }).state;
}

function syncAttribution(
  current: WorkspaceSidePaneState | null,
  overrides: Partial<Parameters<typeof syncSubagentSessionSidePaneTabs>[1]> = {},
): WorkspaceSidePaneState | null {
  return syncSubagentSessionSidePaneTabs(current, {
    rootSessionId: PARENT_ID,
    parentSessionId: PARENT_ID,
    validChildSessionIds: [CHILD_ID],
    workspaceKey: WORKSPACE_KEY,
    childTitles: { [CHILD_ID]: "Child A" },
    ...overrides,
  });
}

test("child 后台 ready 只挂载，不切换父会话当前 tab", () => {
  const { state, shouldReveal } = applyBrowserUseSidePaneEvent(parentState(), childEvent(), {
    workspaceKey: WORKSPACE_KEY,
    ownerTaskId: PARENT_ID,
  });
  assert.equal(shouldReveal, false);
  assert.equal(state.activeTabId, "browser-use:tab-parent");
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    ["browser-use:tab-parent", CHILD_TAB_ID],
  );
  const child = state.tabs.find((tab) => tab.id === CHILD_TAB_ID);
  assert.equal(child?.type === "browser-use" ? child.sessionId : undefined, CHILD_ID);
  // 尚未收到投影归属时，父 strip 不得出现该 child 页面。
  assert.deepEqual(visibleIds(state), ["browser-use:tab-parent"]);
});

test("查看 child 会话时同一事件才展开 child tab", () => {
  const { state, shouldReveal } = applyBrowserUseSidePaneEvent(parentState(), childEvent(), {
    workspaceKey: WORKSPACE_KEY,
    ownerTaskId: CHILD_ID,
  });
  assert.equal(shouldReveal, true);
  assert.equal(state.activeTabId, CHILD_TAB_ID);
});

test("workspace 或 remote scope 不匹配时不展开", () => {
  const otherWorkspace = applyBrowserUseSidePaneEvent(
    parentState(),
    childEvent({ workspaceKey: "ws-2" }),
    { workspaceKey: WORKSPACE_KEY, ownerTaskId: CHILD_ID },
  );
  assert.equal(otherWorkspace.shouldReveal, false);
  assert.equal(otherWorkspace.state.activeTabId, "browser-use:tab-parent");

  const otherRemote = applyBrowserUseSidePaneEvent(
    parentState(),
    { ...childEvent(), remoteSessionId: "remote-b" },
    { workspaceKey: WORKSPACE_KEY, remoteSessionId: "remote-a", ownerTaskId: CHILD_ID },
  );
  assert.equal(otherRemote.shouldReveal, false);
  assert.equal(otherRemote.state.activeTabId, "browser-use:tab-parent");
});

test("父 root 无需先点 Agent：收到投影后 child 页面即可在现有 strip 中被手动选择", () => {
  const ready = readyChild(parentState());
  // 从未打开过 subagent-session tab。
  assert.equal(
    ready.tabs.some((tab) => tab.type === "subagent-session"),
    false,
    "用例前提：没有会话 tab 作为锚点",
  );
  assert.deepEqual(visibleIds(ready), ["browser-use:tab-parent"]);

  const attributed = syncAttribution(ready);
  assert.ok(attributed);
  assert.deepEqual(visibleIds(attributed), ["browser-use:tab-parent", CHILD_TAB_ID]);
  // 归属只影响可见性，不抢焦点。
  assert.equal(attributed.activeTabId, "browser-use:tab-parent");
  const child = attributed.tabs.find((tab) => tab.id === CHILD_TAB_ID);
  assert.equal(child?.type === "browser-use" ? child.sessionId : undefined, CHILD_ID);
  assert.equal(child?.type === "browser-use" ? child.ownerTaskId : undefined, CHILD_ID);
  assert.equal(child?.type === "browser-use" ? child.viewerRootSessionId : undefined, PARENT_ID);
  assert.equal(child?.type === "browser-use" ? child.viewerTitle : undefined, "Child A");
});

test("ready 先到与投影先到两种顺序最终都能在父 root 看到 child tab", () => {
  // ready 先到：tab 立即后台挂载，投影到达后补写归属。
  const readyFirst = readyChild(parentState());
  assert.deepEqual(visibleIds(readyFirst), ["browser-use:tab-parent"]);
  const afterSync = syncAttribution(readyFirst);
  assert.ok(afterSync && visibleIds(afterSync).includes(CHILD_TAB_ID));
  assert.equal(afterSync.activeTabId, "browser-use:tab-parent");

  // 投影先到：同步时还没有 tab；ready 建 tab 后再同步一次即可见。
  const withProjectionOnly = syncAttribution(parentState());
  assert.ok(withProjectionOnly);
  assert.deepEqual(visibleIds(withProjectionOnly), ["browser-use:tab-parent"]);
  const readyAfter = readyChild(withProjectionOnly);
  const readyAfterSync = syncAttribution(readyAfter);
  assert.ok(readyAfterSync && visibleIds(readyAfterSync).includes(CHILD_TAB_ID));
  assert.equal(readyAfterSync.activeTabId, "browser-use:tab-parent");
});

test("同一父 root 的多个 child 页面按各自投影归属区分，互不串用", () => {
  const childB = childBrowserTab({
    id: "browser-use:tab-child-b",
    sessionId: "sess_child_b",
    ownerTaskId: "sess_child_b",
    tabId: "tab-child-b",
    title: "Child B page",
  });
  const bothReady: WorkspaceSidePaneState = {
    tabs: [parentState().tabs[0]!, childBrowserTab(), childB],
    activeTabId: "browser-use:tab-parent",
  };

  const attributed = syncSubagentSessionSidePaneTabs(bothReady, {
    rootSessionId: PARENT_ID,
    parentSessionId: PARENT_ID,
    validChildSessionIds: [CHILD_ID, "sess_child_b"],
    workspaceKey: WORKSPACE_KEY,
    childTitles: { [CHILD_ID]: "Child A", sess_child_b: "Child B" },
  });
  assert.ok(attributed);
  assert.ok(visibleIds(attributed).includes(CHILD_TAB_ID));
  assert.ok(visibleIds(attributed).includes("browser-use:tab-child-b"));

  const a = attributed.tabs.find((tab) => tab.id === CHILD_TAB_ID);
  const b = attributed.tabs.find((tab) => tab.id === "browser-use:tab-child-b");
  assert.equal(a?.type === "browser-use" ? a.viewerTitle : undefined, "Child A");
  assert.equal(b?.type === "browser-use" ? b.viewerTitle : undefined, "Child B");
});

test("其他 root、workspace、remote 的 child 页面不泄漏", () => {
  const otherRoot: WorkspaceSidePaneState = {
    tabs: [
      parentState().tabs[0]!,
      childBrowserTab(),
      childBrowserTab({
        id: "browser-use:tab-other",
        sessionId: "sess_other_child",
        ownerTaskId: "sess_other_child",
        tabId: "tab-other",
      }),
      childBrowserTab({
        id: "browser-use:tab-ws2",
        sessionId: "sess_ws2_child",
        ownerTaskId: "sess_ws2_child",
        workspaceKey: "ws-2",
        tabId: "tab-ws2",
      }),
    ],
    activeTabId: "browser-use:tab-parent",
  };
  // 其他 root 的投影只归属它自己的 child。
  const withOtherRoot = stampBrowserUseViewerAttribution(otherRoot, {
    rootSessionId: "sess_other",
    childSessionIds: ["sess_other_child"],
    workspaceKey: WORKSPACE_KEY,
  });
  // 本 root 的投影只归属本 root 的 child，且 workspace 必须严格一致。
  const attributed = syncSubagentSessionSidePaneTabs(withOtherRoot, {
    rootSessionId: PARENT_ID,
    parentSessionId: PARENT_ID,
    validChildSessionIds: [CHILD_ID, "sess_ws2_child"],
    workspaceKey: WORKSPACE_KEY,
  });
  assert.ok(attributed);
  const visible = visibleIds(attributed);
  assert.ok(visible.includes(CHILD_TAB_ID));
  assert.ok(!visible.includes("browser-use:tab-other"));
  assert.ok(!visible.includes("browser-use:tab-ws2"));
  const ws2 = attributed.tabs.find((tab) => tab.id === "browser-use:tab-ws2");
  assert.equal(
    ws2?.type === "browser-use" ? (ws2.viewerRootSessionId ?? null) : "not-browser-use",
    null,
    "别的 workspace 不得被本 root 冻结归属",
  );

  // remote 严格一致：投影来自 remote-a 时，remote-b 的 tab 不获得归属。
  const remoteMismatch: WorkspaceSidePaneState = {
    tabs: [childBrowserTab({ remoteSessionId: "remote-b" })],
    activeTabId: "",
  };
  const remoteAttributed = syncSubagentSessionSidePaneTabs(remoteMismatch, {
    rootSessionId: PARENT_ID,
    parentSessionId: PARENT_ID,
    validChildSessionIds: [CHILD_ID],
    workspaceKey: WORKSPACE_KEY,
    remoteSessionId: "remote-a",
  });
  assert.ok(remoteAttributed);
  assert.deepEqual(
    getVisibleSidePaneTabs(remoteAttributed.tabs, {
      workspaceKey: WORKSPACE_KEY,
      ownerTaskId: PARENT_ID,
      remoteSessionId: "remote-a",
    }),
    [],
  );
});

test("手动激活 child tab 只改 activeTabId，执行 sessionId 仍是 child", () => {
  const attributed = syncAttribution(readyChild(parentState()));
  assert.ok(attributed);
  const activated = setActiveSidePaneTab(attributed, CHILD_TAB_ID);
  assert.equal(activated?.activeTabId, CHILD_TAB_ID);
  const child = activated?.tabs.find((tab) => tab.id === CHILD_TAB_ID);
  assert.equal(child?.type === "browser-use" ? child.sessionId : undefined, CHILD_ID);
  assert.equal(child?.type === "browser-use" ? child.ownerTaskId : undefined, CHILD_ID);
});

test("同一 tabId 的 ready 重放幂等，不重建第二个 shell，也不丢已冻结归属", () => {
  const first = syncAttribution(readyChild(parentState()));
  assert.ok(first);
  const childBefore = first.tabs.find((tab) => tab.id === CHILD_TAB_ID);
  const replay = readyChild(first);
  const matching = replay.tabs.filter(
    (tab) => tab.type === "browser-use" && tab.tabId === "tab-child",
  );
  assert.equal(matching.length, 1);
  assert.equal(matching[0]?.id, CHILD_TAB_ID);
  assert.equal(
    childBefore?.type === "browser-use" ? childBefore.openedAt : undefined,
    matching[0]?.type === "browser-use" ? matching[0].openedAt : undefined,
  );
  assert.equal(
    matching[0]?.type === "browser-use" ? matching[0].viewerRootSessionId : undefined,
    PARENT_ID,
    "ready 重放不得抹掉已冻结的查看归属",
  );
});

test("关闭 child browser tab 后，operation/visibility 迟到事件不重建 shell", () => {
  const attributed = syncAttribution(readyChild(parentState()));
  assert.ok(attributed);
  const closed = closeSidePaneTab(attributed, CHILD_TAB_ID);
  assert.ok(closed);
  assert.equal(
    closed.tabs.some((tab) => tab.id === CHILD_TAB_ID),
    false,
  );

  const visibility = applyBrowserUseSidePaneVisibilityEvent(
    closed,
    {
      visible: true,
      workspaceKey: WORKSPACE_KEY,
      sessionId: CHILD_ID,
      tabId: "tab-child",
      browserId: "iab-1",
      browserGeneration: 2,
    },
    { workspaceKey: WORKSPACE_KEY, ownerTaskId: PARENT_ID },
  );
  assert.equal(visibility.didMatch, false);
  assert.equal(visibility.state, closed);

  const operation = markBrowserUseSidePaneTabOperation(closed, {
    workspaceKey: WORKSPACE_KEY,
    sessionId: CHILD_ID,
    browserId: "iab-1",
    browserGeneration: 2,
    tabId: "tab-child",
    operationUntil: Date.now() + 1_000,
  });
  assert.equal(operation, closed);
});

test("执行结束、visibility=false、关闭会话 tab 都不隐藏或销毁 child 页面", () => {
  const attributed = syncAttribution(readyChild(parentState()));
  assert.ok(attributed);
  const hidden = applyBrowserUseSidePaneVisibilityEvent(
    attributed,
    {
      visible: false,
      workspaceKey: WORKSPACE_KEY,
      sessionId: CHILD_ID,
      tabId: "tab-child",
      browserId: "iab-1",
      browserGeneration: 2,
    },
    { workspaceKey: WORKSPACE_KEY, ownerTaskId: PARENT_ID },
  );
  assert.ok(hidden.state?.tabs.some((tab) => tab.id === CHILD_TAB_ID));

  // 用户打开过会话 tab 再关闭：页面仍可见（归属冻结在 tab 上，不依赖会话 tab）。
  const withSessionTab = openSubagentSessionSidePane(attributed, {
    workspaceKey: WORKSPACE_KEY,
    workspacePath: "/workspace",
    rootSessionId: PARENT_ID,
    parentSessionId: PARENT_ID,
    childSessionId: CHILD_ID,
    subagentType: "general-purpose",
    title: "Child A",
  });
  const sessionTabId = withSessionTab.tabs.find((tab) => tab.type === "subagent-session")?.id;
  assert.ok(sessionTabId);
  const closedSession = closeSidePaneTab(withSessionTab, sessionTabId);
  assert.ok(closedSession?.tabs.some((tab) => tab.id === CHILD_TAB_ID));
  assert.ok(visibleIds(closedSession).includes(CHILD_TAB_ID));
  // 标题归属不因关闭会话 tab 而丢失。
  const child = closedSession?.tabs.find((tab) => tab.id === CHILD_TAB_ID);
  assert.equal(child?.type === "browser-use" ? child.viewerTitle : undefined, "Child A");
});

test("投影收缩不清除已冻结归属，用户正在看的页面不变成不可达 guest", () => {
  const attributed = syncAttribution(readyChild(parentState()));
  assert.ok(attributed);
  // 分支 edit/retry 后投影里没有这个 child 了。
  const shrunk = syncAttribution(attributed, { validChildSessionIds: [] });
  assert.ok(shrunk);
  assert.ok(visibleIds(shrunk).includes(CHILD_TAB_ID));
  const child = shrunk.tabs.find((tab) => tab.id === CHILD_TAB_ID);
  assert.equal(child?.type === "browser-use" ? child.viewerRootSessionId : undefined, PARENT_ID);
});

test("父会话单 tab 可见性判断复用同一份冻结归属", () => {
  const attributed = syncAttribution(readyChild(parentState()));
  assert.ok(attributed);
  const child = attributed.tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.id === CHILD_TAB_ID,
  );
  assert.ok(child);
  assert.equal(isSidePaneTabVisibleForParent(child, PARENT_ID), true);
  assert.equal(isSidePaneTabVisibleForParent(child, "sess_other"), false);
  assert.equal(isSidePaneTabVisibleForParent(child, PARENT_ID, "remote-a"), false);
  assert.ok(getVisibleSidePaneTabs(attributed, PARENT_ID).some((tab) => tab.id === child.id));
});
