import assert from "node:assert/strict";
import test from "node:test";
import { getSidePaneTabTypeLabel } from "../src/app-shell/sidePaneTabPresentation.js";
import type { SubagentSessionSidePaneTab } from "../src/lib/workspaceSidePane.js";

const labels = {
  browserTitle: "Browser",
  reviewTitle: "Review",
  codeViewerTitle: "Code",
  treemappingTitle: "Map",
  whiteboardTitle: "Board",
  modelTrajectoryTitle: "Trajectory",
  developerToolsTitle: "Devtools",
  terminalTitle: "Terminal",
  sandboxConsoleTitle: "Sandbox",
  subagentTypeLabel: "Subagent",
  workerTypeLabel: "工人",
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

test("侧栏类型名把 Worker 显示成工人文案，其它类型保持原名", () => {
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Worker"), labels), "工人");
  assert.equal(getSidePaneTabTypeLabel(subagentTab("Explore"), labels), "Explore");
  assert.equal(getSidePaneTabTypeLabel(subagentTab(""), labels), "Subagent");
});
