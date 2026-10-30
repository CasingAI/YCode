import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService, InvalidAutomationModeError } from "../src/session/automationService.js";

const require = createRequire(import.meta.url);

function overwriteMode(dbPath: string, automationId: string, mode: string): void {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE automations SET mode = ? WHERE automation_id = ?").run(mode, automationId);
  } finally {
    db.close();
  }
}

async function createAutomation(
  service: AutomationService,
  workspacePath: string,
  mode?: "yolo" | "team",
) {
  return service.create({
    title: "模式测试任务",
    cronExpr: "* * * * *",
    prompt: "执行",
    workspacePath,
    recurring: true,
    ...(mode ? { mode } : {}),
  });
}

test("创建省略档位时服务端落盘 Agent，显式 Team 原样保存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-mode-create-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const service = new AutomationService(repo);
    const defaulted = await createAutomation(service, join(dir, "workspace"));
    assert.equal(defaulted.mode, "yolo");

    const team = await createAutomation(service, join(dir, "workspace"), "team");
    assert.equal(team.mode, "team");
    assert.equal((await repo.get(team.automationId))?.mode, "team");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("创建显式 Plan/只读档位被拒绝，不静默降级", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-mode-invalid-create-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const service = new AutomationService(repo);
    await assert.rejects(
      service.create({
        title: "非法档位",
        cronExpr: "* * * * *",
        prompt: "执行",
        workspacePath: join(dir, "workspace"),
        recurring: true,
        mode: "plan" as never,
      }),
      InvalidAutomationModeError,
    );
    await assert.rejects(
      service.create({
        title: "非法档位",
        cronExpr: "* * * * *",
        prompt: "执行",
        workspacePath: join(dir, "workspace"),
        recurring: true,
        mode: "readonly" as never,
      }),
      InvalidAutomationModeError,
    );
    assert.deepEqual(await repo.list(), []);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("更新省略 mode 保留已存档位，显式切换后才改变", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-mode-update-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const service = new AutomationService(repo);
    const team = await createAutomation(service, join(dir, "workspace"), "team");

    const preserved = await service.update(team.automationId, { title: "仅改标题" });
    assert.equal(preserved?.mode, "team");

    const switched = await service.update(team.automationId, { mode: "yolo" });
    assert.equal(switched?.mode, "yolo");

    await assert.rejects(
      service.update(team.automationId, { mode: "plan" as never }),
      InvalidAutomationModeError,
    );
    assert.equal((await repo.get(team.automationId))?.mode, "yolo");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Repo 写入边界拒绝旧档位，避免绕过服务层继续写脏数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-mode-repo-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const repo = new AutomationRepo(dbPath);
  try {
    const created = await repo.create(
      {
        title: "Repo 任务",
        cronExpr: "* * * * *",
        prompt: "执行",
        workspacePath: join(dir, "workspace"),
        recurring: true,
      },
      { nextRunAt: null },
    );
    // Repo 是内部兼容入口：省略 mode 仍写历史 NULL，不迁移已有空值。
    assert.equal(created.mode, undefined);

    await assert.rejects(
      repo.create(
        {
          title: "Repo 非法任务",
          cronExpr: "* * * * *",
          prompt: "执行",
          workspacePath: join(dir, "workspace"),
          recurring: true,
          mode: "plan" as never,
        },
        { nextRunAt: null },
      ),
      /Invalid automation mode/,
    );
    await assert.rejects(repo.update(created.automationId, { mode: "build" as never }), {
      message: /Invalid automation mode/,
    });
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("历史 NULL 与旧档位只做读取兼容，省略更新不迁移", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-mode-history-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  let repo = new AutomationRepo(dbPath);
  let automationId = "";
  try {
    const created = await repo.create(
      {
        title: "历史任务",
        cronExpr: "* * * * *",
        prompt: "执行",
        workspacePath: join(dir, "workspace"),
        recurring: true,
      },
      { nextRunAt: null },
    );
    automationId = created.automationId;
    // 模拟升级前落盘的空值：省略更新不得把它迁移成 yolo。
    const service = new AutomationService(repo);
    const afterNullUpdate = await service.update(automationId, { title: "标题一" });
    assert.equal(afterNullUpdate?.mode, undefined);
  } finally {
    repo.close();
  }

  try {
    overwriteMode(dbPath, automationId, "plan");
    repo = new AutomationRepo(dbPath);
    const service = new AutomationService(repo);
    assert.equal((await repo.get(automationId))?.mode, "plan");
    const preserved = await service.update(automationId, { title: "标题二" });
    assert.equal(preserved?.mode, "plan");
    // 显式更新仍允许把旧档位纠正为 Team。
    const migrated = await service.update(automationId, { mode: "team" });
    assert.equal(migrated?.mode, "team");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("调度认领返回 Team 档位，供派发链路透传", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-mode-claim-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const service = new AutomationService(repo);
    const automation = await service.create({
      title: "Team 延时任务",
      cronExpr: "* * * * *",
      relativeDelayMinutes: 1,
      prompt: "执行",
      workspacePath: join(dir, "workspace"),
      recurring: false,
      mode: "team",
    });
    const claimed = await repo.claimDue(Date.now() + 120_000);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.automationId, automation.automationId);
    assert.equal(claimed[0]?.mode, "team");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
