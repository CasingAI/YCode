import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { buildFlatMoveOrderInput } from "../../ui/src/lib/flatTaskGroupMove.js";

const WORKSPACE = "/ws-auto-archive-skip-grouped";
const SCOPES = [{ workspacePath: WORKSPACE }];

// 归档候选要求：已完成、无未读、未置顶、updated_at 早于保留期。
function meta(taskId: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: WORKSPACE,
    createdAt: 1,
    updatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    mode: "build",
    status: "completed",
  };
}

async function setupRepo(): Promise<{ dir: string; repo: TaskIndexRepo; groupId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-archive-skip-grouped-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  await repo.syncTaskMeta({ meta: meta("sess-grouped") });
  await repo.syncTaskMeta({ meta: meta("sess-solo") });
  // 「有组」走真实用户路径造数：建组 + 扁平菜单移动提交，与 UI 写入同一事务语义。
  const group = await repo.createTaskGroup({ title: "保留组" });
  const base = await repo.queryGroupedTaskViewStructure({ workspaceScopes: SCOPES });
  await repo.applyGroupedTaskViewOrder(
    buildFlatMoveOrderInput({
      base,
      scopeKey: WORKSPACE,
      movingTask: { workspacePath: WORKSPACE, taskId: "sess-grouped" },
      targetGroupId: group.id,
    }),
  );
  const structure = await repo.queryGroupedTaskViewStructure({ workspaceScopes: SCOPES });
  assert.ok(
    structure.members.some((m) => m.taskId === "sess-grouped" && m.groupId === group.id),
    "前置条件：sess-grouped 应已入组",
  );
  return { dir, repo, groupId: group.id };
}

async function teardownRepo(dir: string, repo: TaskIndexRepo): Promise<void> {
  repo.close();
  setDataBaseDir(null);
  await rm(dir, { recursive: true, force: true });
}

test("skipGrouped=true：有组完成旧任务不归档，无组任务正常归档", async () => {
  const { dir, repo } = await setupRepo();
  try {
    const archived = await repo.archiveStaleTasks({
      workspacePath: WORKSPACE,
      olderThanDays: 7,
      skipGrouped: true,
    });
    assert.deepEqual(
      archived.map((task) => task.taskId).sort(),
      ["sess-solo"],
      "只有无组任务进入归档",
    );
    // 下一轮扫描中有组任务仍是候选，证明上一轮确实没动它。
    const stillCandidate = await repo.archiveStaleTasks({
      workspacePath: WORKSPACE,
      olderThanDays: 7,
      skipGrouped: false,
    });
    assert.deepEqual(
      stillCandidate.map((task) => task.taskId).sort(),
      ["sess-grouped"],
      "关闭跳过后有组任务照常归档",
    );
  } finally {
    await teardownRepo(dir, repo);
  }
});

test("缺省 skipGrouped：保持旧行为，有组任务也会被归档", async () => {
  const { dir, repo } = await setupRepo();
  try {
    const archived = await repo.archiveStaleTasks({
      workspacePath: WORKSPACE,
      olderThanDays: 7,
    });
    assert.deepEqual(
      archived.map((task) => task.taskId).sort(),
      ["sess-grouped", "sess-solo"],
      "repo 层缺省不过滤，默认开启语义由设置 schema 与 adapter 配置层承担",
    );
  } finally {
    await teardownRepo(dir, repo);
  }
});
