import assert from "node:assert/strict";
import test from "node:test";
import type { PlanDetailSidePaneTab } from "../src/lib/workspaceSidePane.js";
import { openPlanDetailSidePane } from "../src/lib/workspaceSidePane.js";

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
