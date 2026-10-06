import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskResultRows,
  type TaskSearchResultItem,
} from "../src/command-center/commandCenterTaskRows.js";

function task(params: {
  taskId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  searchSnippet?: string;
  searchSnippets?: string[];
}): TaskSearchResultItem {
  return {
    taskId: params.taskId,
    traceId: `zcode-${params.taskId}`,
    workspacePath: params.workspacePath ?? "/workspace/app",
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    title: `任务 ${params.taskId}`,
    mode: "build",
    createdAt: 0,
    updatedAt: 0,
    ...(params.searchSnippet ? { searchSnippet: params.searchSnippet } : {}),
    ...(params.searchSnippets ? { searchSnippets: params.searchSnippets } : {}),
  } as TaskSearchResultItem;
}

test("同一任务的多个命中片段合并为一行，行内展示首条并记录剩余数量", () => {
  const rows = buildTaskResultRows({
    tasks: [
      task({
        taskId: "task-1",
        searchSnippets: ["片段一 codex", "片段二 codex", "片段三 codex", "片段四 codex"],
      }),
    ],
    query: "codex",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.searchSnippet, "片段一 codex");
  assert.equal(rows[0]?.snippetIndex, 0);
  assert.equal(rows[0]?.extraSnippetCount, 3);
});

test("同任务重复条目合并时片段取并集并按规范文本去重", () => {
  const rows = buildTaskResultRows({
    tasks: [
      task({ taskId: "task-1", searchSnippets: ["alpha codex", "beta codex"] }),
      task({ taskId: "task-1", searchSnippets: ["...alpha codex...", "gamma codex"] }),
    ],
    query: "codex",
  });

  assert.equal(rows.length, 1);
  // "...alpha codex..." 规范化后与 "alpha codex" 相同，应被去掉。
  assert.equal(rows[0]?.extraSnippetCount, 2);
});

test("标题命中的无片段任务只输出一行且不计剩余片段", () => {
  const rows = buildTaskResultRows({
    tasks: [task({ taskId: "task-title-hit" })],
    query: "codex",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.searchSnippet, undefined);
  assert.equal(rows[0]?.snippetIndex, undefined);
  assert.equal(rows[0]?.extraSnippetCount, 0);
});

test("旧版单片段字段（searchSnippet）仍支持且无剩余计数", () => {
  const rows = buildTaskResultRows({
    tasks: [task({ taskId: "task-legacy", searchSnippet: "旧版片段 codex" })],
    query: "codex",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.searchSnippet, "旧版片段 codex");
  assert.equal(rows[0]?.extraSnippetCount, 0);
});

test("不同任务不合并，保持输入顺序", () => {
  const rows = buildTaskResultRows({
    tasks: [
      task({ taskId: "task-a", searchSnippets: ["a codex"] }),
      task({ taskId: "task-b", searchSnippets: ["b codex"] }),
    ],
    query: "codex",
  });

  assert.deepEqual(
    rows.map((row) => row.task.taskId),
    ["task-a", "task-b"],
  );
  assert.ok(rows.every((row) => row.extraSnippetCount === 0));
});
