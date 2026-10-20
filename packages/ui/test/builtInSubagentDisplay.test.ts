import assert from "node:assert/strict";
import test from "node:test";
import { getSidePaneTabTypeLabel } from "../src/app-shell/sidePaneTabPresentation.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { resolveBuiltInSubagentChatTypeLabel } from "../src/lib/builtInSubagentDisplay.js";
import type { SubagentSessionSidePaneTab } from "../src/lib/workspaceSidePane.js";

const zhLabels = {
  browserTitle: "Browser",
  reviewTitle: "Review",
  codeViewerTitle: "Code",
  treemappingTitle: "Map",
  whiteboardTitle: "Board",
  modelTrajectoryTitle: "Trajectory",
  developerToolsTitle: "Devtools",
  terminalTitle: "Terminal",
  sandboxConsoleTitle: "Sandbox",
  subagentTypeLabel: "子智能体",
  builtInSubagentTypeTexts: {
    "general-purpose": "通用",
    Explore: "探索",
    Worker: "工人",
  },
  subagentDirectoryTitle: "Directory",
  selectionChatTitle: "Chat",
  planTitle: "Plan",
  planDirectoryTitle: "Plans",
  workflowRunTitle: "Run",
  workflowDirectoryTitle: "Runs",
  workflowActorTitle: "Actor",
  workflowScriptTitle: "Script",
  workflowArtifactTitle: "Artifact",
};

const enLabels = {
  ...zhLabels,
  subagentTypeLabel: "Subagent",
  builtInSubagentTypeTexts: {
    "general-purpose": "general-purpose",
    Explore: "Explore",
    Worker: "Worker",
  },
};

function subagentTab(subagentType: string): SubagentSessionSidePaneTab {
  return {
    id: "tab-1",
    type: "subagent-session",
    workspaceKey: "/repo",
    workspacePath: "/repo",
    rootSessionId: "root",
    parentSessionId: "parent",
    childSessionId: "child",
    subagentType,
    title: "Investigate cache",
  };
}

test("侧栏类型名中文下 Worker 与 SmartWorker 都复用同一展示文本", () => {
  assert.equal(getSidePaneTabTypeLabel(subagentTab("SmartWorker"), zhLabels), "工人");
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Worker"), zhLabels), "工人");
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Explore"), zhLabels), "探索");
  assert.equal(getSidePaneTabTypeLabel(subagentTab("general-purpose"), zhLabels), "通用");
  assert.equal(getSidePaneTabTypeLabel(subagentTab("custom-agent"), zhLabels), "custom-agent");
  assert.equal(getSidePaneTabTypeLabel(subagentTab(""), zhLabels), "子智能体");
});

test("侧栏类型名英文下与身份一致", () => {
  assert.equal(getSidePaneTabTypeLabel(subagentTab("SmartWorker"), enLabels), "Worker");
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Worker"), enLabels), "Worker");
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Explore"), enLabels), "Explore");
  assert.equal(
    getSidePaneTabTypeLabel(subagentTab("general-purpose"), enLabels),
    "general-purpose",
  );
});

function chatTypeLabel(value: string, messages: Record<string, string>): string {
  return resolveBuiltInSubagentChatTypeLabel(
    value,
    (messageId, fallback) => messages[messageId] ?? fallback,
  );
}

test("聊天 Agent 工具卡的中文类型名", () => {
  assert.equal(chatTypeLabel("Explore", zhCN), "探索");
  assert.equal(chatTypeLabel("general-purpose", zhCN), "通用");
  assert.equal(chatTypeLabel("Worker", zhCN), "工人");
  assert.equal(chatTypeLabel("SmartWorker", zhCN), "工人");
  assert.equal(chatTypeLabel("custom-agent", zhCN), "custom-agent");
  assert.equal(chatTypeLabel("", zhCN), "");
});

test("聊天 Agent 工具卡的英文类型名保持原文", () => {
  assert.equal(chatTypeLabel("Explore", enUS), "Explore");
  assert.equal(chatTypeLabel("general-purpose", enUS), "general-purpose");
  assert.equal(chatTypeLabel("Worker", enUS), "Worker");
  assert.equal(chatTypeLabel("SmartWorker", enUS), "Worker");
  assert.equal(chatTypeLabel("custom-agent", enUS), "custom-agent");
});

test("聊天类型名缺失语言包条目时回退英文身份名", () => {
  assert.equal(chatTypeLabel("Explore", {}), "Explore");
  assert.equal(chatTypeLabel("general-purpose", {}), "general-purpose");
  assert.equal(chatTypeLabel("Worker", {}), "Worker");
});
