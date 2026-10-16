import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRepo } from "../src/session/automationRepo.js";

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
