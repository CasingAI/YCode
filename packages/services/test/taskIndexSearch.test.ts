import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { setDataBaseDir } from "../src/paths.js";
import type { ZCodeTaskMeta } from "../src/session/zcodeTaskService.js";

const PROVIDER = "glm" as const;
const SCOPES = [{ workspacePath: "/workspace/app" }];

function meta(params: { taskId: string; title: string }): ZCodeTaskMeta {
  const now = Date.now();
  return {
    taskId: params.taskId,
    traceId: `zcode-${params.taskId}`,
    workspacePath: "/workspace/app",
    title: params.title,
    mode: "build",
    provider: PROVIDER,
    createdAt: now,
    updatedAt: now,
  };
}

async function withRepo<T>(run: (repo: TaskIndexRepo) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-index-search-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    return await run(repo);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("默认搜索命中标题或正文，正文命中返回摘要片段", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-title-hit", title: "修复 Codex 登录" }),
      searchableText: "正文里没有关键词",
    });
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-body-hit", title: "无关标题" }),
      searchableText: "用户反馈 Codex 登录超时，需要排查会话记录",
    });

    const result = await repo.queryTaskList({
      kind: "active",
      workspaceScopes: SCOPES,
      sortBy: "updated",
      search: "codex",
    });

    assert.deepEqual(result.items.map((item) => item.taskId).sort(), [
      "task-body-hit",
      "task-title-hit",
    ]);
    const bodyHit = result.items.find((item) => item.taskId === "task-body-hit");
    assert.ok(bodyHit?.searchSnippet?.toLocaleLowerCase().includes("codex"));
  });
});

test("仅标题搜索不返回正文命中的会话，也不构建摘要片段", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-title-hit", title: "修复 Codex 登录" }),
      searchableText: "正文提到 codex 但标题没有",
    });
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-body-hit", title: "无关标题" }),
      searchableText: "用户反馈 Codex 登录超时",
    });

    const result = await repo.queryTaskList({
      kind: "active",
      workspaceScopes: SCOPES,
      sortBy: "updated",
      search: "codex",
      searchTitlesOnly: true,
    });

    assert.deepEqual(
      result.items.map((item) => item.taskId),
      ["task-title-hit"],
    );
    assert.equal(result.items[0]?.searchSnippet, undefined);
    assert.equal(result.items[0]?.searchSnippets, undefined);
  });
});

test("正文多次命中时摘要片段去重且最多 4 条", async () => {
  await withRepo(async (repo) => {
    // 每个关键词出现位置间隔超过摘要窗口宽度（前 20 / 后 72 字符），
    // 保证窗口不重叠、可以产出多条片段。
    const repeatedBody = `${"x".repeat(100)}codex `.repeat(10).trim();
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-multi", title: "codex 汇总" }),
      searchableText: repeatedBody,
    });

    const result = await repo.queryTaskList({
      kind: "active",
      workspaceScopes: SCOPES,
      sortBy: "updated",
      search: "codex",
    });

    assert.equal(result.items.length, 1);
    const snippets = result.items[0]?.searchSnippets ?? [];
    assert.ok(snippets.length > 1, "分散命中应产出多条片段");
    assert.ok(snippets.length <= 4, "片段数不能超过 TASK_SEARCH_SNIPPET_LIMIT");
  });
});

test("置顶会话在全文与仅标题搜索中均命中（active 未归档即命中）", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-pinned", title: "Z消息按整轮加载与贴底防抖" }),
      searchableText: "正文里没有关键词",
      pinned: true,
    });
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-body-hit", title: "无关标题" }),
      searchableText: "正文引用《消息按整轮加载与贴底防抖》",
    });

    const fullText = await repo.queryTaskList({
      kind: "active",
      workspaceScopes: SCOPES,
      sortBy: "updated",
      search: "消息按整轮加载",
    });
    assert.deepEqual(fullText.items.map((item) => item.taskId).sort(), [
      "task-body-hit",
      "task-pinned",
    ]);

    const titlesOnly = await repo.queryTaskList({
      kind: "active",
      workspaceScopes: SCOPES,
      sortBy: "updated",
      search: "消息按整轮加载",
      searchTitlesOnly: true,
    });
    assert.deepEqual(
      titlesOnly.items.map((item) => item.taskId),
      ["task-pinned"],
    );
    assert.equal(titlesOnly.items[0]?.searchSnippet, undefined);
    assert.equal(titlesOnly.items[0]?.searchSnippets, undefined);
  });
});

test("timeline 查询仍排除置顶会话", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-pinned", title: "Z消息按整轮加载与贴底防抖" }),
      pinned: true,
    });
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-timeline", title: "普通时间线会话" }),
    });

    const result = await repo.queryTaskList({
      kind: "timeline",
      workspaceScopes: SCOPES,
      sortBy: "updated",
    });
    assert.deepEqual(
      result.items.map((item) => item.taskId),
      ["task-timeline"],
    );
  });
});
