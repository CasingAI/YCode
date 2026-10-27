import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { setDataBaseDir } from "../src/paths.js";

const WORKSPACE_PATH = "/example/workspace";
const TASK_ID = "task-watermark";

function buildMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: TASK_ID,
    traceId: "trace-watermark",
    title: "跨端已读水位",
    workspacePath: WORKSPACE_PATH,
    mode: "build",
    provider: "glm",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

async function withRepo(
  run: (repo: TaskIndexRepo, dir: string) => Promise<void>,
  meta: ZCodeTaskMeta = buildMeta(),
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-watermark-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({ meta });
    await run(repo, dir);
  } finally {
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
}

function params(meta: ZCodeTaskMeta = buildMeta()) {
  return {
    workspacePath: meta.workspacePath,
    ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    taskId: meta.taskId,
  };
}

test("先确认已读到 T 后，迟到的同版本终态不产生未读", async () => {
  await withRepo(async (repo) => {
    const read = await repo.recordTaskRead({
      ...params(),
      seenActivityAt: 1_000,
    });
    assert.equal(read.seenAdvanced, true);
    assert.equal(read.unreadCleared, false);
    assert.equal(read.meta.lastSeenActivityAt, 1_000);
    assert.equal(read.meta.unreadAt, undefined);

    const terminal = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 1_000,
    });
    assert.equal(terminal.advanced, false, "已读水位覆盖的终态不得分配未读");
    assert.equal(terminal.meta.unreadAt, undefined);
    assert.equal(terminal.meta.lastSeenActivityAt, 1_000);
  });
});

test("先产生自动未读再确认同版本已读会清除，重复终态不再产生未读", async () => {
  await withRepo(async (repo) => {
    const first = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 1_000,
    });
    assert.equal(first.advanced, true);
    assert.ok(typeof first.meta.unreadAt === "number");

    const duplicate = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 1_000,
    });
    assert.equal(duplicate.advanced, false, "重复终态必须幂等");
    assert.equal(duplicate.meta.unreadAt, first.meta.unreadAt);

    const read = await repo.recordTaskRead({
      ...params(),
      seenActivityAt: 1_000,
      expectedUnreadAt: first.meta.unreadAt,
    });
    assert.equal(read.unreadCleared, true);
    assert.equal(read.meta.unreadAt, undefined);
    assert.equal(read.meta.lastSeenActivityAt, 1_000);

    const late = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 1_000,
    });
    assert.equal(late.advanced, false);
    assert.equal(late.meta.unreadAt, undefined);
  });
});

test("更高终态重新分配 marker，旧 CAS 与旧已读不得清除新未读", async () => {
  await withRepo(async (repo) => {
    const first = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 1_000,
    });
    const firstMarker = first.meta.unreadAt;
    assert.ok(typeof firstMarker === "number");

    // 只看到 T1 不得清除 T2 的自动未读：先落后一条更低终态，再推进到更高终态。
    const staleRead = await repo.recordTaskRead({
      ...params(),
      seenActivityAt: 900,
      expectedUnreadAt: firstMarker,
    });
    assert.equal(staleRead.unreadCleared, false);
    assert.equal(staleRead.meta.unreadAt, firstMarker);
    assert.equal(staleRead.meta.lastSeenActivityAt, 900);

    const second = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 2_000,
    });
    assert.equal(second.advanced, true);
    assert.ok(typeof second.meta.unreadAt === "number");
    assert.ok(
      second.meta.unreadAt > firstMarker,
      "更高终态必须分配新的严格递增 marker，避免旧点击 CAS 命中",
    );

    // 迟到的旧点击带旧 marker，不能清除新终态未读。
    const lateOldClick = await repo.recordTaskRead({
      ...params(),
      seenActivityAt: 1_000,
      expectedUnreadAt: firstMarker,
    });
    assert.equal(lateOldClick.unreadCleared, false);
    assert.equal(lateOldClick.meta.unreadAt, second.meta.unreadAt);
    assert.equal(lateOldClick.meta.lastSeenActivityAt, 1_000);

    // 水位尚未覆盖 T2 时，即使 marker 匹配也不能清掉更高终态。
    const matchingButLowerSeen = await repo.recordTaskRead({
      ...params(),
      seenActivityAt: 1_500,
      expectedUnreadAt: second.meta.unreadAt,
    });
    assert.equal(matchingButLowerSeen.unreadCleared, false);
    assert.equal(matchingButLowerSeen.meta.unreadAt, second.meta.unreadAt);

    const finalRead = await repo.recordTaskRead({
      ...params(),
      seenActivityAt: 2_000,
      expectedUnreadAt: second.meta.unreadAt,
    });
    assert.equal(finalRead.unreadCleared, true);
    assert.equal(finalRead.meta.unreadAt, undefined);
    assert.equal(finalRead.meta.lastSeenActivityAt, 2_000);
  });
});

test("乱序旧终态不重复分配 marker，也不回退未读版本或水位", async () => {
  await withRepo(async (repo) => {
    const newer = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 2_000,
    });
    const older = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 1_500,
    });
    assert.equal(older.advanced, false);
    assert.equal(older.meta.unreadAt, newer.meta.unreadAt);
    assert.equal(older.meta.lastSeenActivityAt ?? 0, 0);

    await repo.recordTaskRead({ ...params(), seenActivityAt: 1_800 });
    const olderAgain = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 1_500,
    });
    assert.equal(olderAgain.advanced, false);
    assert.equal(
      olderAgain.meta.unreadAt,
      newer.meta.unreadAt,
      "旧终态不得重新分配 marker，也不能清除更新的终态未读",
    );
    assert.equal(olderAgain.meta.lastSeenActivityAt, 1_800);
  });
});

test("手动/存量未读不被自动终态转换，也不被正文水位误清", async () => {
  await withRepo(async (repo) => {
    const manual = await repo.updateTaskState({
      ...params(),
      patch: { unreadAt: 1_234 },
    });
    assert.ok(typeof manual.unreadAt === "number");

    const terminal = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 2_000,
    });
    assert.equal(terminal.advanced, false, "手动未读不转换成自动未读");
    assert.equal(terminal.meta.unreadAt, manual.unreadAt);

    const seen = await repo.recordTaskRead({
      ...params(),
      seenActivityAt: 2_000,
    });
    assert.equal(seen.seenAdvanced, true);
    assert.equal(seen.unreadCleared, false, "正文水位不得清除手动未读");
    assert.equal(seen.meta.unreadAt, manual.unreadAt);

    const explicitClear = await repo.recordTaskRead({
      ...params(),
      seenActivityAt: 2_000,
      expectedUnreadAt: manual.unreadAt,
    });
    assert.equal(explicitClear.unreadCleared, true);
    assert.equal(explicitClear.meta.unreadAt, undefined);
  });
});

test("seed/upsert/快照同步都不能覆盖或回退已读水位", async () => {
  await withRepo(async (repo) => {
    await repo.recordTaskRead({ ...params(), seenActivityAt: 2_500 });

    const seeded = await repo.seedTaskMetaIfMissing(buildMeta({ title: "seed 标题" }));
    assert.equal(seeded.lastSeenActivityAt, 2_500);

    const upserted = await repo.syncTaskMeta({
      meta: buildMeta({ title: "快照标题", updatedAt: 2_100, lastSeenActivityAt: 100 }),
    });
    assert.equal(upserted.title, "快照标题");
    assert.equal(upserted.lastSeenActivityAt, 2_500, "sync 携带更低水位不得回退");

    const read = await repo.getTaskMeta(params());
    assert.equal(read?.lastSeenActivityAt, 2_500, "getTaskMeta 必须返回最新水位");
    assert.equal(read?.title, "快照标题");
  });
});

test("legacy expectedUnreadAt CAS 清除行为保持", async () => {
  await withRepo(async (repo) => {
    const unread = await repo.updateTaskState({ ...params(), patch: { unreadAt: 3_000 } });
    const stale = await repo.clearTaskUnreadIfMatches({
      ...params(),
      expectedUnreadAt: unread.unreadAt! - 1,
    });
    assert.equal(stale.cleared, false);
    assert.equal(stale.meta.unreadAt, unread.unreadAt);

    const cleared = await repo.clearTaskUnreadIfMatches({
      ...params(),
      expectedUnreadAt: unread.unreadAt!,
    });
    assert.equal(cleared.cleared, true);
    assert.equal(cleared.meta.unreadAt, undefined);
  });
});

test("workspaceIdentity 隔离：同路径不同远端的水位与未读互不影响", async () => {
  const local = buildMeta();
  const remoteA = buildMeta({ workspaceIdentity: "remote-a" });
  const remoteB = buildMeta({ workspaceIdentity: "remote-b" });
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-watermark-identity-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({ meta: remoteA });
    await repo.syncTaskMeta({ meta: remoteB });

    await repo.recordTaskRead({ ...params(remoteA), seenActivityAt: 5_000 });
    const terminalB = await repo.markTaskUnreadIfUnseen({
      ...params(remoteB),
      terminalActivityAt: 5_000,
    });
    assert.ok(typeof terminalB.meta.unreadAt === "number", "另一个 identity 不应继承水位");
    assert.equal(terminalB.meta.lastSeenActivityAt ?? 0, 0);

    const metaA = await repo.getTaskMeta(params(remoteA));
    assert.equal(metaA?.lastSeenActivityAt, 5_000);
    assert.equal(metaA?.unreadAt, undefined);
    assert.equal((await repo.getTaskMeta(params(local)))?.lastSeenActivityAt, undefined);
  } finally {
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("marker 保持 Host 时间语义，同毫秒与时钟回退时严格递增", async () => {
  await withRepo(async (repo) => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const first = await repo.markTaskUnreadIfUnseen({
        ...params(),
        terminalActivityAt: 2_000,
      });
      assert.equal(first.meta.unreadAt, 1_000, "marker 首值取 Host 时间");

      const sameMillisecond = await repo.markTaskUnreadIfUnseen({
        ...params(),
        terminalActivityAt: 2_100,
      });
      assert.equal(sameMillisecond.meta.unreadAt, 1_001, "同毫秒必须严格递增");

      now = 500;
      const clockRollback = await repo.markTaskUnreadIfUnseen({
        ...params(),
        terminalActivityAt: 2_200,
      });
      assert.equal(clockRollback.meta.unreadAt, 1_002, "时钟回退不得复用或回退 marker");
    } finally {
      Date.now = originalNow;
    }
  });
});

test("非法活动版本必须拒绝且不改变水位/未读，之后仍可正常写入", async () => {
  await withRepo(async (repo) => {
    const invalidValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const value of invalidValues) {
      await assert.rejects(
        repo.markTaskUnreadIfUnseen({ ...params(), terminalActivityAt: value }),
        TypeError,
      );
      await assert.rejects(repo.recordTaskRead({ ...params(), seenActivityAt: value }), TypeError);
    }

    const untouched = await repo.getTaskMeta(params());
    assert.equal(untouched?.lastSeenActivityAt, undefined, "非法 seen 不得推进水位");
    assert.equal(untouched?.unreadAt, undefined, "非法 terminal 不得制造未读");

    const read = await repo.recordTaskRead({ ...params(), seenActivityAt: 1_000 });
    assert.equal(read.seenAdvanced, true);
    assert.equal(read.meta.lastSeenActivityAt, 1_000);
    const terminal = await repo.markTaskUnreadIfUnseen({
      ...params(),
      terminalActivityAt: 2_000,
    });
    assert.equal(terminal.advanced, true, "拒绝非法值后正常调用必须仍然有效");
  });
});

test("并发重复终态只分配一次 marker，并发 seen/terminal 最终收敛为已读", async () => {
  await withRepo(async (repo) => {
    const duplicated = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.markTaskUnreadIfUnseen({ ...params(), terminalActivityAt: 4_000 }),
      ),
    );
    const markers = new Set(duplicated.map((result) => result.meta.unreadAt));
    assert.equal(markers.size, 1, "重复终态必须幂等");

    await repo.recordTaskRead({ ...params(), seenActivityAt: 4_000 });
    const meta = await repo.getTaskMeta(params());
    assert.equal(meta?.unreadAt, undefined);
    assert.equal(meta?.lastSeenActivityAt, 4_000);
  });

  const dir = await mkdtemp(join(tmpdir(), "zcode-task-watermark-race-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({ meta: buildMeta() });
    // 无论 Host 先接纳 seen 还是 terminal，同一版本的最终事实都必须是已读。
    await Promise.all([
      repo.recordTaskRead({ ...params(), seenActivityAt: 6_000 }),
      repo.markTaskUnreadIfUnseen({ ...params(), terminalActivityAt: 6_000 }),
    ]);
    const meta = await repo.getTaskMeta(params());
    assert.equal(meta?.unreadAt, undefined);
    assert.equal(meta?.lastSeenActivityAt, 6_000);
  } finally {
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
