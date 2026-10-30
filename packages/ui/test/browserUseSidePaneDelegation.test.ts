import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBrowserUseSidePaneEvent,
  type BrowserUseSidePaneTab,
  type WorkspaceSidePaneState,
} from "../src/lib/workspaceSidePane.js";

// 子代理 own-tabs 回归（docs/specs/subagent-browser-use-delegation.md 验收 12/13）：
// child session 的 ready 事件只能在其 origin workspace/session 被查看时展开；
// 父会话或其他 workspace 只后台挂载 guest，不切换 activeTab，也不抢焦点。
// 用纯状态函数和 fakes，不连接 YCode、不启动浏览器。

function parentState(): WorkspaceSidePaneState {
  const tab: BrowserUseSidePaneTab = {
    id: "browser-use:tab-parent",
    type: "browser-use",
    sessionId: "sess_parent",
    ownerTaskId: "sess_parent",
    workspaceKey: "ws-1",
    tabId: "tab-parent",
  };
  return { tabs: [tab], activeTabId: tab.id };
}

function childEvent(overrides: Partial<{ sessionId: string; workspaceKey: string }> = {}) {
  return {
    workspaceKey: "ws-1",
    sessionId: "sess_child",
    tabId: "tab-child",
    browserId: "iab-1",
    browserGeneration: 2,
    ...overrides,
  };
}

test("child 后台 ready 只挂载，不切换父会话当前 tab", () => {
  const { state, shouldReveal } = applyBrowserUseSidePaneEvent(parentState(), childEvent(), {
    workspaceKey: "ws-1",
    ownerTaskId: "sess_parent",
  });
  assert.equal(shouldReveal, false);
  assert.equal(state.activeTabId, "browser-use:tab-parent");
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    ["browser-use:tab-parent", "browser-use:tab-child"],
  );
  const child = state.tabs.find((tab) => tab.id === "browser-use:tab-child");
  assert.equal(child?.type === "browser-use" ? child.sessionId : undefined, "sess_child");
});

test("查看 child 会话时同一事件才展开 child tab", () => {
  const { state, shouldReveal } = applyBrowserUseSidePaneEvent(parentState(), childEvent(), {
    workspaceKey: "ws-1",
    ownerTaskId: "sess_child",
  });
  assert.equal(shouldReveal, true);
  assert.equal(state.activeTabId, "browser-use:tab-child");
});

test("workspace 或 remote scope 不匹配时不展开", () => {
  const otherWorkspace = applyBrowserUseSidePaneEvent(
    parentState(),
    childEvent({ workspaceKey: "ws-2" }),
    { workspaceKey: "ws-1", ownerTaskId: "sess_child" },
  );
  assert.equal(otherWorkspace.shouldReveal, false);
  assert.equal(otherWorkspace.state.activeTabId, "browser-use:tab-parent");

  const otherRemote = applyBrowserUseSidePaneEvent(
    parentState(),
    { ...childEvent(), remoteSessionId: "remote-b" },
    { workspaceKey: "ws-1", remoteSessionId: "remote-a", ownerTaskId: "sess_child" },
  );
  assert.equal(otherRemote.shouldReveal, false);
  assert.equal(otherRemote.state.activeTabId, "browser-use:tab-parent");
});
