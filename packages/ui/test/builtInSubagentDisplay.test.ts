import assert from "node:assert/strict";
import test from "node:test";
import { getSidePaneTabTypeLabel } from "../src/app-shell/sidePaneTabPresentation.js";
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

test("侧栏类型名中文下三个内置走本地化，其它类型保持原名", () => {
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Worker"), zhLabels), "工人");
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Explore"), zhLabels), "探索");
  assert.equal(
    getSidePaneTabTypeLabel(subagentTab("general-purpose"), zhLabels),
    "通用",
  );
  assert.equal(getSidePaneTabTypeLabel(subagentTab("custom-agent"), zhLabels), "custom-agent");
  assert.equal(getSidePaneTabTypeLabel(subagentTab(""), zhLabels), "子智能体");
});

test("侧栏类型名英文下与身份一致", () => {
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Worker"), enLabels), "Worker");
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Explore"), enLabels), "Explore");
  assert.equal(
    getSidePaneTabTypeLabel(subagentTab("general-purpose"), enLabels),
    "general-purpose",
  );
});
