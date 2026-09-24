import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { setDataBaseDir } from "../src/paths.js";
import type { ZCodeTaskMeta } from "../src/session/zcodeTaskService.js";

const PROVIDER = "glm" as const;
/** 旧索引行没有 provider 列：显式用这个哨兵造出 provider IS NULL 的行。 */
const NO_PROVIDER = "none" as const;

function meta(params: {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeTaskMeta["provider"] | typeof NO_PROVIDER;
}): ZCodeTaskMeta {
  const now = Date.now();
  return {
    taskId: params.taskId,
    traceId: `zcode-${params.taskId}`,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    title: `任务 ${params.taskId}`,
    mode: "build",
    ...(params.provider === NO_PROVIDER ? {} : { provider: params.provider ?? PROVIDER }),
    createdAt: now,
    updatedAt: now,
  };
}

async function withRepo<T>(run: (repo: TaskIndexRepo) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-resolve-workspace-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    return await run(repo);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("本地任务反查出路径且不带 identity", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({ meta: meta({ taskId: "task-local", workspacePath: "/local/app" }) });

    assert.deepEqual(await repo.resolveTaskWorkspace("task-local", PROVIDER), {
      workspacePath: "/local/app",
    });
  });
});

test("远端任务的身份取自行主键，与 workspace_identity 列是否残留无关", async () => {
  await withRepo(async (repo) => {
    const identity = "remote:ssh:example.com:22:root:/srv/app";
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-remote", workspacePath: "/srv/app", workspaceIdentity: identity }),
    });

    assert.deepEqual(await repo.resolveTaskWorkspace("task-remote", PROVIDER), {
      workspacePath: "/srv/app",
      workspaceIdentity: identity,
    });
  });
});

test("反查按当前 runtime 的 provider 过滤，历史无 provider 的行不算命中", async () => {
  await withRepo(async (repo) => {
    // provider 列为空的是旧索引行，当前 runtime 打不开它，不能参与反查。
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-shared-id", workspacePath: "/legacy/app", provider: NO_PROVIDER }),
    });
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-shared-id", workspacePath: "/current/app", provider: PROVIDER }),
    });

    assert.deepEqual(await repo.resolveTaskWorkspace("task-shared-id", PROVIDER), {
      workspacePath: "/current/app",
    });
  });
});

test("同 provider 下同 taskId 命中多个 workspace 时视为归属不唯一", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({ meta: meta({ taskId: "task-dup", workspacePath: "/workspace/a" }) });
    await repo.syncTaskMeta({ meta: meta({ taskId: "task-dup", workspacePath: "/workspace/b" }) });

    assert.equal(await repo.resolveTaskWorkspace("task-dup", PROVIDER), null);
  });
});

test("软删除的任务不再反查得到", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({
      meta: meta({ taskId: "task-gone", workspacePath: "/workspace/gone" }),
      deleted: true,
    });

    assert.equal(await repo.resolveTaskWorkspace("task-gone", PROVIDER), null);
  });
});
