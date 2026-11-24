import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBrowserUseSidePaneEvent,
  type WorkspaceSidePaneState,
} from "../src/lib/workspaceSidePane.js";

// 代理标签页在 side pane 状态中的标记链路（docs/specs/browser-tab-proxy.md）：
// Ready 事件携带 usesProxy，tab 据此挂代理分区 webview 并显示角标；
// 旧 payload 重放不得抹掉已有标记，普通 tab 保持字段缺省以兼容旧事件流。

const SCOPE = { workspaceKey: "ws-1", ownerTaskId: "sess_parent" };

function readTab(state: WorkspaceSidePaneState, tabId: string) {
  const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
  assert.ok(tab, `tab ${tabId} 不存在`);
  return tab;
}

function proxyEvent(overrides: Partial<Parameters<typeof applyBrowserUseSidePaneEvent>[1]> = {}) {
  return {
    workspaceKey: "ws-1",
    sessionId: "sess_parent",
    tabId: "tab-proxy",
    usesProxy: true,
    ...overrides,
  };
}

test("Ready 事件 usesProxy:true 落到 side pane tab 上", () => {
  const { state } = applyBrowserUseSidePaneEvent(null, proxyEvent(), SCOPE);
  assert.equal(readTab(state, "tab-proxy").usesProxy, true);
});

test("普通 tab 事件不带 usesProxy 时字段保持缺省，不污染旧事件流", () => {
  const { state } = applyBrowserUseSidePaneEvent(
    null,
    { workspaceKey: "ws-1", sessionId: "sess_parent", tabId: "tab-normal" },
    SCOPE,
  );
  assert.equal(readTab(state, "tab-normal").usesProxy, undefined);
});

test("旧 payload 重放不抹掉已有代理标记", () => {
  const first = applyBrowserUseSidePaneEvent(null, proxyEvent(), SCOPE);
  const second = applyBrowserUseSidePaneEvent(
    first.state,
    // 模拟旧 renderer/重放路径：payload 里没有 usesProxy 字段。
    { workspaceKey: "ws-1", sessionId: "sess_parent", tabId: "tab-proxy" },
    SCOPE,
  );
  assert.equal(readTab(second.state, "tab-proxy").usesProxy, true);
});

test("main 侧最新值优先：usesProxy 由 true 更新为 false 时以新值为准", () => {
  const first = applyBrowserUseSidePaneEvent(null, proxyEvent(), SCOPE);
  const second = applyBrowserUseSidePaneEvent(
    first.state,
    proxyEvent({ usesProxy: false }),
    SCOPE,
  );
  assert.equal(readTab(second.state, "tab-proxy").usesProxy, false);
});
