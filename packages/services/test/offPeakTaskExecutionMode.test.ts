import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServiceLogger } from "../src/logger/serviceLogger.js";
import { OffPeakTaskRepo } from "../src/session/offPeakTaskRepo.js";
import { OffPeakTaskService } from "../src/session/offPeakTaskService.js";
import type { OffPeakServerClient } from "../src/session/offPeakServerClient.js";

const require = createRequire(import.meta.url);

const silentLogger = createServiceLogger("offpeak-mode-test", {
  isDebugEnabled: false,
  sink: { log() {}, warn() {}, error() {}, debug() {} },
});

function createService(dbPath: string) {
  const repo = new OffPeakTaskRepo(dbPath);
  const client = {
    takeTicket: async (taskId: string) => ({
      ticketId: `ticket-${taskId}`,
      state: "queued" as const,
      registeredAt: Date.now(),
    }),
  } as unknown as OffPeakServerClient;
  const service = new OffPeakTaskService({
    repo,
    client,
    resolveCodingPlanSupport: async () => ({}) as never,
    resolveTelemetryProviderName: async () => "",
    resolveModelSelection: async (input) => ({
      ok: true,
      selection: { providerId: "provider-1", modelId: input.modelId ?? "model-1" },
    }),
    logger: silentLogger,
  });
  return { repo, service };
}

function createParams(workspacePath: string, permissionMode?: "yolo" | "team") {
  return {
    title: "闲时任务",
    prompt: "重构 utils",
    workspacePath,
    modelSelection: { providerId: "provider-1", modelId: "model-1" },
    ...(permissionMode ? { permissionMode } : {}),
  };
}

function overwritePermissionMode(dbPath: string, offPeakTaskId: string, mode: string): void {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE off_peak_tasks SET permission_mode = ? WHERE off_peak_task_id = ?").run(
      mode,
      offPeakTaskId,
    );
  } finally {
    db.close();
  }
}

test("闲时任务创建省略档位落盘 Agent，显式 Team 原样保存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-offpeak-mode-create-"));
  const { repo, service } = createService(join(dir, "tasks-index.sqlite"));
  try {
    const defaulted = await service.createTask(createParams(join(dir, "workspace")));
    assert.equal(defaulted.ok, true);
    assert.equal(defaulted.ok && defaulted.task.permissionMode, "yolo");

    const team = await service.createTask(createParams(join(dir, "workspace"), "team"));
    assert.equal(team.ok, true);
    assert.equal(team.ok && team.task.permissionMode, "team");
  } finally {
    service.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("闲时任务创建非法档位在客户端校验阶段拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-offpeak-mode-invalid-create-"));
  const { repo, service } = createService(join(dir, "tasks-index.sqlite"));
  try {
    const rejected = await service.createTask({
      ...createParams(join(dir, "workspace")),
      permissionMode: "plan" as never,
    });
    assert.equal(rejected.ok, false);
    assert.equal(!rejected.ok && rejected.failureStage, "client_validation");
    assert.deepEqual(await repo.list(), []);
  } finally {
    service.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("闲时任务更新省略档位保留，显式切换和非法写入被拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-offpeak-mode-update-"));
  const { repo, service } = createService(join(dir, "tasks-index.sqlite"));
  try {
    const created = await service.createTask(createParams(join(dir, "workspace"), "team"));
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const preserved = await service.updateTask(created.task.offPeakTaskId, { title: "仅改标题" });
    assert.equal(preserved?.permissionMode, "team");

    const switched = await service.updateTask(created.task.offPeakTaskId, {
      permissionMode: "yolo",
    });
    assert.equal(switched?.permissionMode, "yolo");

    const rejected = await service.updateTask(created.task.offPeakTaskId, {
      permissionMode: "readonly" as never,
    });
    assert.equal(rejected, null);
    assert.equal((await repo.get(created.task.offPeakTaskId))?.permissionMode, "yolo");
  } finally {
    service.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("闲时任务 Repo 写入边界拒绝旧档位", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-offpeak-mode-repo-"));
  const { repo, service } = createService(join(dir, "tasks-index.sqlite"));
  try {
    await assert.rejects(
      repo.create(
        {
          ...createParams(join(dir, "workspace")),
          permissionMode: "build" as never,
        },
        { offPeakTaskId: "offpeak-invalid", serverTicketId: "ticket-invalid" },
      ),
      /Invalid off-peak permission mode/,
    );

    const created = await service.createTask(createParams(join(dir, "workspace"), "team"));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await assert.rejects(
      repo.updateEditableFields(created.task.offPeakTaskId, {
        permissionMode: "edit" as never,
      }),
      /Invalid off-peak permission mode/,
    );
  } finally {
    service.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("闲时任务历史旧档位只做读取兼容，省略更新不迁移", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-offpeak-mode-history-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  let handle = createService(dbPath);
  let { repo, service } = handle;
  let offPeakTaskId = "";
  try {
    const created = await service.createTask(createParams(join(dir, "workspace"), "team"));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    offPeakTaskId = created.task.offPeakTaskId;
  } finally {
    service.disposeAll();
    repo.close();
  }

  try {
    overwritePermissionMode(dbPath, offPeakTaskId, "plan");
    handle = createService(dbPath);
    repo = handle.repo;
    service = handle.service;
    assert.equal((await repo.get(offPeakTaskId))?.permissionMode, "plan");

    const preserved = await service.updateTask(offPeakTaskId, { title: "历史标题" });
    assert.equal(preserved?.permissionMode, "plan");

    const migrated = await service.updateTask(offPeakTaskId, { permissionMode: "team" });
    assert.equal(migrated?.permissionMode, "team");
  } finally {
    service.disposeAll();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
