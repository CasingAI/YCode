import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";

test("延时任务已认领时拒绝编辑并保留认领状态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-delay-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const automation = await repo.create(
      {
        title: "延时任务",
        cronExpr: "* * * * *",
        relativeDelayMinutes: 5,
        prompt: "执行一次",
        workspacePath: join(dir, "workspace"),
        recurring: false,
      },
      { nextRunAt: Date.now() - 1_000 },
    );

    const claimed = await repo.claimDue(Date.now());
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.automationId, automation.automationId);

    const updated = await repo.update(automation.automationId, { title: "修改标题" });
    assert.equal(updated, null);

    const saved = await repo.get(automation.automationId);
    assert.equal(saved?.title, "延时任务");
    assert.equal(saved?.dispatchStatus, "claimed");
    assert.deepEqual(await repo.claimDue(Date.now()), []);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("定义编辑不会在事务检查后覆盖并发认领", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-scheduled-edit-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const automation = await repo.create(
      {
        title: "定时任务",
        cronExpr: "* * * * *",
        prompt: "执行",
        workspacePath: join(dir, "workspace"),
        recurring: true,
      },
      { nextRunAt: Date.now() - 1_000 },
    );
    assert.equal((await repo.claimDue(Date.now())).length, 1);
    const updated = await repo.update(automation.automationId, { title: "不能覆盖认领" });
    assert.equal(updated, null);
    assert.equal((await repo.get(automation.automationId))?.title, "定时任务");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("普通编辑不会更改延时任务计划或生命周期", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-delay-edit-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const targetAt = Date.now() + 60_000;
    const automation = await repo.create(
      {
        title: "延时任务",
        cronExpr: "* * * * *",
        relativeDelayMinutes: 2,
        prompt: "执行一次",
        workspacePath: join(dir, "workspace"),
        recurring: false,
      },
      { nextRunAt: targetAt },
    );
    const before = await repo.get(automation.automationId);
    assert.ok(before);

    const updated = await repo.update(automation.automationId, { title: "修改标题" });
    assert.equal(updated?.title, "修改标题");
    assert.equal(updated?.nextRunAt, before.nextRunAt);
    assert.equal(updated?.delayMinutes, before.delayMinutes);
    assert.equal(updated?.lifecycleStatus, before.lifecycleStatus);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("服务层重新安排按分钟从服务端时间精确计算且不被 Cron 覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-delay-service-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const service = new AutomationService(repo);
    const automation = await service.create({
      title: "延时任务",
      cronExpr: "* * * * *",
      relativeDelayMinutes: 3,
      prompt: "执行一次",
      workspacePath: join(dir, "workspace"),
      recurring: false,
    });
    const before = Date.now();
    const updated = await service.update(automation.automationId, {
      title: "修改后延时任务",
      relativeDelayMinutes: 17,
      recurring: false,
      maxRuns: null,
    });
    const after = Date.now();

    assert.ok(updated);
    assert.equal(updated.delayMinutes, 17);
    assert.ok(updated.nextRunAt >= before + 17 * 60_000);
    assert.ok(updated.nextRunAt <= after + 17 * 60_000);
    assert.equal(updated.recurring, false);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("迟到的成功与失败回执不能结算后续计划认领", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-stale-dispatch-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const firstScheduledAt = Date.now() - 2_000;
    const nextScheduledAt = Date.now() - 1_000;
    const automation = await repo.create(
      {
        title: "延时任务",
        cronExpr: "* * * * *",
        relativeDelayMinutes: 2,
        prompt: "执行一次",
        workspacePath: join(dir, "workspace"),
        recurring: false,
      },
      { nextRunAt: firstScheduledAt },
    );
    const [firstClaim] = await repo.claimDue(Date.now());
    assert.ok(firstClaim);
    assert.equal(
      await repo.markDispatched(automation.automationId, {
        dispatchedAt: Date.now(),
        nextRunAt: null,
        scheduledAt: firstScheduledAt,
      }),
      true,
    );
    await repo.update(
      automation.automationId,
      { relativeDelayMinutes: 3 },
      { nextRunAt: nextScheduledAt, lifecycleStatus: "active", resetRetry: true },
    );
    const [nextClaim] = await repo.claimDue(Date.now());
    assert.equal(nextClaim?.nextRunAt, nextScheduledAt);
    assert.ok(nextClaim);
    await repo.upsertRunClaimed({
      runId: `${automation.automationId}:${nextScheduledAt}`,
      automationId: automation.automationId,
      workspaceKey: nextClaim.workspaceKey,
      scheduledAt: nextScheduledAt,
      trigger: "schedule",
    });

    assert.equal(
      await repo.markDispatched(automation.automationId, {
        dispatchedAt: Date.now(),
        nextRunAt: Date.now() + 60_000,
        scheduledAt: firstScheduledAt,
      }),
      false,
    );
    assert.equal(
      await repo.markDispatchFailed(automation.automationId, {
        failedAt: Date.now(),
        error: "迟到失败",
        kind: "permanent",
        scheduledAt: firstScheduledAt,
      }),
      false,
    );
    const saved = await repo.get(automation.automationId);
    assert.equal(saved?.nextRunAt, nextScheduledAt);
    assert.equal(saved?.dispatchStatus, "claimed");
    assert.equal(saved?.lifecycleStatus, "active");
    assert.equal(saved?.runCount, 1);
    assert.equal(saved?.lastError, undefined);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delay 派发成功后作为一次性任务完成", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-delay-dispatch-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const automation = await repo.create(
      {
        title: "延时任务",
        cronExpr: "* * * * *",
        relativeDelayMinutes: 2,
        prompt: "执行一次",
        workspacePath: join(dir, "workspace"),
        recurring: false,
      },
      { nextRunAt: Date.now() - 1_000 },
    );
    const [claimed] = await repo.claimDue(Date.now());
    assert.equal(claimed?.automationId, automation.automationId);
    assert.ok(claimed);

    await repo.markDispatched(automation.automationId, {
      dispatchedAt: Date.now(),
      nextRunAt: Date.now() + 60_000,
      scheduledAt: claimed.nextRunAt,
    });

    const saved = await repo.get(automation.automationId);
    assert.equal(saved?.lifecycleStatus, "completed");
    assert.equal(saved?.enabled, false);
    assert.equal(saved?.nextRunAt, undefined);

    await repo.markDispatched(automation.automationId, {
      dispatchedAt: Date.now(),
      nextRunAt: Date.now() + 60_000,
      scheduledAt: claimed.nextRunAt,
    });
    assert.equal((await repo.get(automation.automationId))?.lifecycleStatus, "completed");
    assert.equal((await repo.get(automation.automationId))?.runCount, 1);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
