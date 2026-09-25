import assert from "node:assert/strict";
import test from "node:test";
import type {
  PlanDetailSidePaneTab,
  PlanDirectorySidePaneTab,
} from "../src/lib/workspaceSidePane.js";
import {
  getVisibleSidePaneTabs,
  isSidePaneTabVisibleForParent,
  openPlanDetailSidePane,
  openPlanDirectorySidePane,
} from "../src/lib/workspaceSidePane.js";

// 详情面板头部优先读父会话投影里的实时值，tab 上的 title 只在投影缺席时兜底
// （会话滚远、冷启动）。所以它必须真的随打开请求落到 tab 上，否则头部会空掉。
// 概述不进 tab：面板不渲染它，它只在折叠卡上出现。

const BASE_OPEN_REQUEST = {
  workspaceKey: "/repo",
  workspacePath: "/repo",
  parentSessionId: "sess_1",
  toolCallId: "call_1",
  markdown: "# 计划",
};

function findPlanTab(tabs: readonly { type: string }[]): PlanDetailSidePaneTab | undefined {
  return tabs.find((tab): tab is PlanDetailSidePaneTab => tab.type === "plan-detail");
}

test("openPlanDetailSidePane：title 随打开请求进入 tab，概述不落 tab", () => {
  const state = openPlanDetailSidePane(null, {
    ...BASE_OPEN_REQUEST,
    title: "缓存验收",
  });
  const tab = findPlanTab(state.tabs);
  assert.equal(tab?.title, "缓存验收");
  assert.equal(tab !== undefined && "overview" in tab, false);
});

test("openPlanDetailSidePane：同一 toolCall 重开只留一个 tab，冻结字段被新值刷新", () => {
  const first = openPlanDetailSidePane(null, {
    ...BASE_OPEN_REQUEST,
    title: "旧标题",
  });
  const second = openPlanDetailSidePane(first, {
    ...BASE_OPEN_REQUEST,
    markdown: "# 新计划",
    title: "新标题",
    planFilePath: "/repo/.zcode/plans/sess_1/20260923-120000000-call_1.md",
  });
  const planTabs = second.tabs.filter((tab) => tab.type === "plan-detail");
  assert.equal(planTabs.length, 1);
  const tab = findPlanTab(second.tabs);
  assert.equal(tab?.markdown, "# 新计划");
  assert.equal(tab?.title, "新标题");
  assert.equal(tab?.planFilePath, "/repo/.zcode/plans/sess_1/20260923-120000000-call_1.md");
});

test("openPlanDetailSidePane：历史调用无 title/planFilePath 时字段缺席，不写空串", () => {
  const state = openPlanDetailSidePane(null, BASE_OPEN_REQUEST);
  const tab = findPlanTab(state.tabs);
  assert.notEqual(tab, undefined);
  assert.equal(tab !== undefined && "title" in tab, false);
  assert.equal(tab !== undefined && "planFilePath" in tab, false);
});

function findPlanDirectoryTab(
  tabs: readonly { type: string }[],
): PlanDirectorySidePaneTab | undefined {
  return tabs.find((tab): tab is PlanDirectorySidePaneTab => tab.type === "plan-directory");
}

test("openPlanDirectorySidePane：同一 workspace/session 幂等复用目录 tab", () => {
  const first = openPlanDirectorySidePane(null, {
    workspaceKey: "/repo",
    workspacePath: "/repo",
    parentSessionId: "sess_1",
  });
  const second = openPlanDirectorySidePane(first, {
    workspaceKey: "/repo",
    workspacePath: "/repo",
    parentSessionId: "sess_1",
  });
  const directoryTabs = second.tabs.filter((tab) => tab.type === "plan-directory");
  assert.equal(directoryTabs.length, 1);
  assert.equal(findPlanDirectoryTab(second.tabs)?.parentSessionId, "sess_1");
  assert.equal(second.activeTabId, findPlanDirectoryTab(second.tabs)?.id);
});

test("openPlanDirectorySidePane：不同 workspace 或 session 使用不同 tab", () => {
  const first = openPlanDirectorySidePane(null, {
    workspaceKey: "/repo-a",
    workspacePath: "/repo-a",
    parentSessionId: "sess_1",
  });
  const second = openPlanDirectorySidePane(first, {
    workspaceKey: "/repo-b",
    workspacePath: "/repo-b",
    parentSessionId: "sess_2",
  });
  assert.equal(second.tabs.filter((tab) => tab.type === "plan-directory").length, 2);
  const repoATab = second.tabs.find(
    (tab) => tab.type === "plan-directory" && tab.workspaceKey === "/repo-a",
  );
  const repoBTab = second.tabs.find(
    (tab) => tab.type === "plan-directory" && tab.workspaceKey === "/repo-b",
  );
  assert.notEqual(repoATab?.id, repoBTab?.id);
});

test("计划目录和详情 tab 将 remote session 纳入身份", () => {
  const first = openPlanDirectorySidePane(null, {
    workspaceKey: "/repo",
    workspacePath: "/repo",
    parentSessionId: "sess_1",
    remoteSessionId: "remote-a",
  });
  const second = openPlanDirectorySidePane(first, {
    workspaceKey: "/repo",
    workspacePath: "/repo",
    parentSessionId: "sess_1",
    remoteSessionId: "remote-b",
  });
  const remoteATab = findPlanDirectoryTab(
    second.tabs.filter(
      (tab): tab is PlanDirectorySidePaneTab =>
        tab.type === "plan-directory" && tab.remoteSessionId === "remote-a",
    ),
  );
  const remoteBTab = findPlanDirectoryTab(
    second.tabs.filter(
      (tab): tab is PlanDirectorySidePaneTab =>
        tab.type === "plan-directory" && tab.remoteSessionId === "remote-b",
    ),
  );
  assert.notEqual(remoteATab?.id, remoteBTab?.id);

  const detail = openPlanDetailSidePane(second, {
    ...BASE_OPEN_REQUEST,
    remoteSessionId: "remote-a",
  });
  const remoteDetail = openPlanDetailSidePane(detail, {
    ...BASE_OPEN_REQUEST,
    remoteSessionId: "remote-b",
  });
  const detailTabs = remoteDetail.tabs.filter((tab) => tab.type === "plan-detail");
  assert.equal(detailTabs.length, 2);
  assert.notEqual(detailTabs[0]?.id, detailTabs[1]?.id);
});

test("计划目录按 remote session 收窄可见性", () => {
  const state = openPlanDirectorySidePane(null, {
    workspaceKey: "/repo",
    workspacePath: "/repo",
    parentSessionId: "sess_1",
    remoteSessionId: "remote-a",
  });
  const visibleForRemoteA = getVisibleSidePaneTabs(state.tabs, {
    workspaceKey: "/repo",
    ownerTaskId: "sess_1",
    remoteSessionId: "remote-a",
  });
  const visibleForRemoteB = getVisibleSidePaneTabs(state.tabs, {
    workspaceKey: "/repo",
    ownerTaskId: "sess_1",
    remoteSessionId: "remote-b",
  });
  assert.equal(visibleForRemoteA.length, 1);
  assert.equal(visibleForRemoteB.length, 0);
});

test("计划目录 tab 按 parent session 收窄可见性", () => {
  const state = openPlanDirectorySidePane(null, {
    workspaceKey: "/repo",
    workspacePath: "/repo",
    parentSessionId: "sess_1",
  });
  const tab = findPlanDirectoryTab(state.tabs);
  assert.ok(tab);
  assert.equal(isSidePaneTabVisibleForParent(tab, "sess_1"), true);
  assert.equal(isSidePaneTabVisibleForParent(tab, "sess_2"), false);
});

test("parent-only 清理在 remote scope 缺席时仍保留可回收的远程计划 tab", () => {
  const state = openPlanDirectorySidePane(null, {
    workspaceKey: "/repo",
    workspacePath: "/repo",
    parentSessionId: "sess_1",
    remoteSessionId: "remote-a",
  });
  const tab = findPlanDirectoryTab(state.tabs);
  assert.ok(tab);
  assert.equal(isSidePaneTabVisibleForParent(tab, "sess_1"), true);
  assert.equal(getVisibleSidePaneTabs(state, "sess_1").length, 1);
});
