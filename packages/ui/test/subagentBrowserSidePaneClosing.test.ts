import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBrowserUseSidePaneEvent,
  closeVisibleOtherSidePaneTabs,
  closeVisibleSidePaneTabs,
  getVisibleSidePaneTabs,
  isSidePaneTabVisibleForParent,
  openSubagentSessionSidePane,
  setActiveSidePaneTab,
  syncSubagentSessionSidePaneTabs,
  type WorkspaceSidePaneState,
} from "../src/lib/workspaceSidePane.js";

// 回归（docs/specs/subagent-browser-use-delegation.md 验收 21）：
// 查看归属冻结在 browser-use tab 上，不再依赖临时 subagent-session tab 作为锚点。
// 因此关闭会话 tab、关闭其他 tab 都不会让正在看的 child 页面变成不可见或不可关闭的残留。

const WORKSPACE_KEY = "ws-1";
const PARENT_ID = "sess_parent";
const CHILD_ID = "sess_child";
const CHILD_TAB_ID = "browser-use:tab-child";

function parentBrowserTab() {
  return {
    id: "browser-use:tab-parent",
    type: "browser-use" as const,
    sessionId: PARENT_ID,
    ownerTaskId: PARENT_ID,
    workspaceKey: WORKSPACE_KEY,
    tabId: "tab-parent",
    title: "Parent page",
  };
}

// 用户流程：child ready 后台挂载 -> 根会话投影同步归属 -> 手动点开 child 页面。
function openedWithActiveChild(): WorkspaceSidePaneState {
  const parent = parentBrowserTab();
  const ready = applyBrowserUseSidePaneEvent(
    { tabs: [parent], activeTabId: parent.id },
    {
      workspaceKey: WORKSPACE_KEY,
      sessionId: CHILD_ID,
      tabId: "tab-child",
      browserId: "iab",
      browserGeneration: 2,
    },
    { workspaceKey: WORKSPACE_KEY, ownerTaskId: PARENT_ID },
  ).state;
  const attributed = syncSubagentSessionSidePaneTabs(ready, {
    rootSessionId: PARENT_ID,
    parentSessionId: PARENT_ID,
    validChildSessionIds: [CHILD_ID],
    workspaceKey: WORKSPACE_KEY,
    childTitles: { [CHILD_ID]: "Child A" },
  });
  return setActiveSidePaneTab(attributed, CHILD_TAB_ID) ?? attributed!;
}

function visibleIds(state: WorkspaceSidePaneState | null): string[] {
  return state
    ? state.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, PARENT_ID)).map((tab) => tab.id)
    : [];
}

test("在 child browser tab 上关闭其他 tab 后，当前 child 页面仍然可见", () => {
  const state = openedWithActiveChild();
  assert.ok(visibleIds(state).includes(CHILD_TAB_ID));

  const next = closeVisibleOtherSidePaneTabs(state, CHILD_TAB_ID, PARENT_ID);

  assert.ok(
    next && visibleIds(next).includes(CHILD_TAB_ID),
    `关闭其他 tab 后 child 页面仍应可见，实际可见：${visibleIds(next).join(",") || "(空)"}`,
  );
  assert.equal(next?.activeTabId, CHILD_TAB_ID);
});

test("关闭子代理会话 tab 后，其 browser 页面仍可见可关闭", () => {
  const state = openedWithActiveChild();
  const withSessionTab = openSubagentSessionSidePane(state, {
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

  const withoutSession: WorkspaceSidePaneState = {
    tabs: withSessionTab.tabs.filter((tab) => tab.id !== sessionTabId),
    activeTabId: withSessionTab.activeTabId,
  };
  assert.ok(visibleIds(withoutSession).includes(CHILD_TAB_ID));
  assert.deepEqual(
    getVisibleSidePaneTabs(withoutSession, PARENT_ID).map((tab) => tab.id),
    ["browser-use:tab-parent", CHILD_TAB_ID],
  );
});

test("关闭全部会收掉父 scope 下全部可见 tab，不留下不可达 child guest", () => {
  const state = openedWithActiveChild();
  assert.ok(visibleIds(state).includes(CHILD_TAB_ID));

  const next = closeVisibleSidePaneTabs(state, PARENT_ID);

  assert.equal(
    next === null || !next.tabs.some((tab) => tab.id === CHILD_TAB_ID),
    true,
    `关闭全部后不应残留不可关闭的 child tab，实际：${next?.tabs.map((tab) => tab.id).join(",") ?? "null"}`,
  );
  assert.equal(next === null || next.tabs.length === 0, true);
});
