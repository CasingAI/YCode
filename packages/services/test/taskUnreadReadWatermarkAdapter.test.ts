import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { setDataBaseDir } from "../src/paths.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";

const WORKSPACE_PATH = "/example/workspace";
const TASK_ID = "task-adapter-watermark";

interface Broadcast {
  reason: ZCodeWorkspaceTaskListChanged["reason"];
  meta?: ZCodeTaskMeta;
  options?: Partial<Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal" | "terminalActivityAt">>;
}

function buildMeta(): ZCodeTaskMeta {
  return {
    taskId: TASK_ID,
    traceId: "trace-adapter-watermark",
    title: "适配器已读水位",
    workspacePath: WORKSPACE_PATH,
    mode: "build",
    provider: "glm",
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

test("adapter 透传 terminal/seen 水位，重复终态不重复广播，seen 推进广播任务变更", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-adapter-watermark-"));
  setDataBaseDir(dir);
  const taskIndexRepo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const broadcasts: Broadcast[] = [];
  const disposable = () => ({ dispose() {} });
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const service = createZCodeTaskServiceAdapter({
    taskIndexRepo,
    zcodeAgentService: {
      onDynamicSessionEvent() {
        return () => disposable();
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexSyncer: {
      emitWorkspaceTaskListChanged(
        _target: unknown,
        meta: ZCodeTaskMeta | undefined,
        reason: Broadcast["reason"],
        options?: Broadcast["options"],
      ) {
        broadcasts.push({ reason, meta, options });
      },
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  const target = { taskId: TASK_ID, workspacePath: WORKSPACE_PATH };
  const readMeta = () => taskIndexRepo.getTaskMeta(target);
  try {
    await taskIndexRepo.syncTaskMeta({ meta: buildMeta() });

    const seenFirst = await service.setTaskUnread({
      ...target,
      unread: false,
      seenActivityAt: 4_000,
    });
    assert.equal(seenFirst.lastSeenActivityAt, 4_000);
    assert.equal(seenFirst.unreadAt, undefined);
    assert.equal(broadcasts.length, 1, "seen 推进必须广播 task_meta_changed");
    assert.equal(broadcasts[0]?.reason, "task_meta_changed");

    const lateTerminal = await service.setTaskUnread({
      ...target,
      unread: true,
      terminalActivityAt: 3_500,
    });
    assert.equal(lateTerminal.unreadAt, undefined, "迟到终态不得制造未读");
    assert.equal(broadcasts.length, 1, "无变化的裁决不需要额外广播");

    const newTerminal = await service.setTaskUnread({
      ...target,
      unread: true,
      terminalActivityAt: 5_000,
    });
    assert.ok(typeof newTerminal.unreadAt === "number");
    assert.equal(broadcasts.length, 2);

    const duplicate = await service.setTaskUnread({
      ...target,
      unread: true,
      terminalActivityAt: 5_000,
    });
    assert.equal(duplicate.unreadAt, newTerminal.unreadAt);
    assert.equal(broadcasts.length, 2, "重复终态必须幂等且不制造额外广播");

    const afterOverlay = await readMeta();
    assert.equal(afterOverlay?.lastSeenActivityAt, 4_000);
    assert.equal(afterOverlay?.unreadAt, newTerminal.unreadAt, "getTaskMeta 不得被 overlay 掩盖");

    const read = await service.setTaskUnread({
      ...target,
      unread: false,
      seenActivityAt: 5_000,
      expectedUnreadAt: newTerminal.unreadAt,
    });
    assert.equal(read.unreadAt, undefined);
    assert.equal(read.lastSeenActivityAt, 5_000);
    assert.equal(broadcasts.length, 3);

    // 手动未读走 legacy 分支，仍只由显式 CAS 或手动操作清除。
    const manual = await service.setTaskUnread({ ...target, unread: true });
    assert.ok(typeof manual.unreadAt === "number");
    const seenOverManual = await service.setTaskUnread({
      ...target,
      unread: false,
      seenActivityAt: 6_000,
    });
    assert.equal(seenOverManual.unreadAt, manual.unreadAt);
    assert.equal(seenOverManual.lastSeenActivityAt, 6_000);
    const clearManual = await service.setTaskUnread({
      ...target,
      unread: false,
      seenActivityAt: 6_000,
      expectedUnreadAt: manual.unreadAt,
    });
    assert.equal(clearManual.unreadAt, undefined);
  } finally {
    service.disposeAll();
    taskIndexRepo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adapter 对显式非法活动版本直接拒绝且不触发 resume，省略字段保持 legacy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-adapter-invalid-"));
  setDataBaseDir(dir);
  const taskIndexRepo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  let resumeCalls = 0;
  const disposable = () => ({ dispose() {} });
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const service = createZCodeTaskServiceAdapter({
    taskIndexRepo,
    zcodeAgentService: {
      onDynamicSessionEvent() {
        return () => disposable();
      },
      async resumeSession() {
        resumeCalls++;
        throw new Error("非法活动版本不得触发 resume");
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexSyncer: {
      emitWorkspaceTaskListChanged() {},
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  const target = { taskId: TASK_ID, workspacePath: WORKSPACE_PATH };
  const readMeta = () => taskIndexRepo.getTaskMeta(target);
  try {
    await taskIndexRepo.syncTaskMeta({ meta: buildMeta() });
    const manual = await service.setTaskUnread({ ...target, unread: true });
    assert.ok(typeof manual.unreadAt === "number");

    // null 是运行时绕过类型的显式值，不能被当作省略。
    const invalidValues: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
    ];
    for (const value of invalidValues) {
      await assert.rejects(
        service.setTaskUnread({
          ...target,
          unread: true,
          terminalActivityAt: value as number,
        }),
        TypeError,
      );
      await assert.rejects(
        service.setTaskUnread({
          ...target,
          unread: false,
          seenActivityAt: value as number,
          expectedUnreadAt: manual.unreadAt,
        }),
        TypeError,
      );
    }

    assert.equal(resumeCalls, 0, "非法值必须在 seed/resume 前被拒绝");
    const unchanged = await readMeta();
    assert.equal(unchanged?.unreadAt, manual.unreadAt, "非法 seen 不得降级 legacy 清未读");
    assert.equal(unchanged?.lastSeenActivityAt, undefined);

    // 只有显式省略 seenActivityAt 时才保留 legacy 无条件清除。
    const legacyClear = await service.setTaskUnread({ ...target, unread: false });
    assert.equal(legacyClear.unreadAt, undefined);
  } finally {
    service.disposeAll();
    taskIndexRepo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
