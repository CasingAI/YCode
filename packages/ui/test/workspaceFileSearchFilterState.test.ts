import assert from "node:assert/strict";
import test from "node:test";
import {
  projectWorkspaceFileSearchFilterSnapshot,
  type WorkspaceFileSearchFilterRequest,
} from "../src/workspace-file-search/useWorkspaceFileSearchFilter.js";

function request(
  patch: Partial<WorkspaceFileSearchFilterRequest> = {},
): WorkspaceFileSearchFilterRequest {
  return {
    packed: "index-a",
    rootPath: "/workspace",
    query: "app",
    options: { requireQuery: true, include: "src/**", exclude: "" },
    ...patch,
  };
}

const entries = [
  {
    name: "app.ts",
    relativePath: "src/app.ts",
    path: "/workspace/src/app.ts",
    type: "file" as const,
  },
];

test("过滤尚未完成时不把旧关键词或旧范围结果当成当前结果", () => {
  const previousRequest = request();
  const snapshot = { request: previousRequest, items: entries };
  for (const next of [
    request({ query: "test" }),
    request({ options: { include: "tools/**" } }),
    request({ options: { exclude: "**/*.ts" } }),
    request({ options: { allowedPaths: [] } }),
    request({ packed: "index-b" }),
    request({ rootPath: "/other-workspace" }),
  ]) {
    assert.deepEqual(projectWorkspaceFileSearchFilterSnapshot(next, snapshot), {
      items: [],
      filtering: true,
    });
  }
});

test("只显示属于当前过滤请求的结果，空结果也明确完成", () => {
  const current = request();
  assert.deepEqual(projectWorkspaceFileSearchFilterSnapshot(current, null), {
    items: [],
    filtering: true,
  });
  assert.deepEqual(
    projectWorkspaceFileSearchFilterSnapshot(current, { request: current, items: entries }),
    { items: entries, filtering: false },
  );
  assert.deepEqual(
    projectWorkspaceFileSearchFilterSnapshot(current, { request: current, items: [] }),
    { items: [], filtering: false },
  );
});
