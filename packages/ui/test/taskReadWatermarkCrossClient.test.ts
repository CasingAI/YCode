import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import { TaskIndexRepo } from "../../services/src/session/taskIndexRepo.js";
import { setDataBaseDir } from "../../services/src/paths.js";
import { resolveTerminalNotificationDecision } from "../src/lib/taskReadWatermark.js";
import { buildTaskEntityKey } from "../src/lib/taskQueryCache.js";
import {
  reconcileTaskMetaChangedEvent,
  syncTaskUnreadFromStatusWorkspaceEvent,
} from "../src/lib/taskStatusUnreadSync.js";
import { useTaskQueryCacheStore } from "../src/store/taskQueryCacheStore.js";
import { getTaskUnreadIndicator, useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

/**
 * 跨端链路回归：UI store/事件裁决 + 真实 tasks-index 事务。
 *
 * 用真实 `TaskIndexRepo` 承载 Host 的 `markTaskUnreadIfUnseen` / `recordTaskRead`
 * 事务语义，按 adapter 相同规则广播 task_meta_changed；覆盖手机 seen 与桌面
 * 迟到终态/迟到回包的竞态，而不是只对桩断言调用次数。
 */
type RepoBackedTaskService = Pick<IZCodeTaskService, "setTaskUnread" | "getTaskMeta">;

const T1 = 1_000;
const T2 = 2_000;

function buildMeta(params: { workspacePath: string; taskId: string }): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: "跨端已读水位",
    workspacePath: params.workspacePath,
    status: "completed",
    mode: "build",
    provider: "glm",
    createdAt: 1,
    updatedAt: 2,
  };
}

function taskParams(workspacePath: string, taskId: string) {
  return { workspacePath, taskId };
}

function terminalStatusEvent(params: {
  workspacePath: string;
  taskId: string;
  terminalActivityAt: number;
}): ZCodeWorkspaceTaskListChanged {
  return {
    type: "workspace_task_list_changed",
    workspacePath: params.workspacePath,
    taskId: params.taskId,
    reason: "task_status_changed",
    unreadSignal: "background_terminal",
    terminalActivityAt: params.terminalActivityAt,
    taskMeta: {
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      status: "completed",
      updatedAt: params.terminalActivityAt,
    } as ZCodeWorkspaceTaskListChanged["taskMeta"],
  };
}

function metaChangedEvent(meta: ZCodeTaskMeta): ZCodeWorkspaceTaskListChanged {
  return {
    type: "workspace_task_list_changed",
    workspacePath: meta.workspacePath,
    taskId: meta.taskId,
    ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    reason: "task_meta_changed",
    taskMeta: meta,
  };
}

function createRepoBackedService(repo: TaskIndexRepo): RepoBackedTaskService {
  const emit = (meta: ZCodeTaskMeta) => {
    // 与 zcodeTaskServiceAdapter 相同：只有未读/水位真正变化才广播。
    reconcileTaskMetaChangedEvent(metaChangedEvent(meta));
  };
  return {
    async setTaskUnread(params) {
      if (params.unread && typeof params.terminalActivityAt === "number") {
        const result = await repo.markTaskUnreadIfUnseen({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          terminalActivityAt: params.terminalActivityAt,
        });
        if (result.advanced) {
          emit(result.meta);
        }
        return result.meta;
      }
      if (!params.unread && typeof params.seenActivityAt === "number") {
        const result = await repo.recordTaskRead({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          seenActivityAt: params.seenActivityAt,
        });
        if (result.seenAdvanced || result.unreadCleared) {
          emit(result.meta);
        }
        return result.meta;
      }
      throw new Error("repo-backed service 只实现 versioned unread/seen 分支");
    },
    getTaskMeta: (params) => repo.getTaskMeta(params),
  };
}

function resetQueryCache(): void {
  useTaskQueryCacheStore.setState({
    taskMetaByEntityKey: {},
    taskUnreadOverlayByEntityKey: {},
  });
}

async function withRepo(
  run: (repo: TaskIndexRepo) => Promise<void>,
  meta: ZCodeTaskMeta,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ui-watermark-chain-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await repo.syncTaskMeta({ meta });
    await run(repo);
  } finally {
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
}

test("真实 tasks-index：T1 未读 → T2 完成 → seen(T1) 不误清 T2，seen(T2) 才清除并静音", async () => {
  resetQueryCache();
  const workspacePath = "/cross-client/workspace-t1-t2";
  const taskId = "task-cross-client-t1-t2";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  const meta = buildMeta({ workspacePath, taskId });

  await withRepo(async (repo) => {
    const service = createRepoBackedService(repo);

    await syncTaskUnreadFromStatusWorkspaceEvent({
      event: terminalStatusEvent({ workspacePath, taskId, terminalActivityAt: T1 }),
      service,
    });
    const afterT1 = await repo.getTaskMeta(taskParams(workspacePath, taskId));
    assert.ok(typeof afterT1?.unreadAt === "number", "T1 必须产生自动未读");
    const t1Marker = afterT1.unreadAt;

    await syncTaskUnreadFromStatusWorkspaceEvent({
      event: terminalStatusEvent({ workspacePath, taskId, terminalActivityAt: T2 }),
      service,
    });
    const afterT2 = await repo.getTaskMeta(taskParams(workspacePath, taskId));
    assert.ok(typeof afterT2?.unreadAt === "number");
    assert.ok(afterT2.unreadAt > t1Marker, "T2 必须推进 Host unread_activity_at 与 marker");
    const t2Marker = afterT2.unreadAt;
    assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], t2Marker);

    const beforeSeen = await resolveTerminalNotificationDecision({
      taskId,
      workspacePath,
      terminalActivityAt: T2,
      service,
    });
    assert.deepEqual(beforeSeen, { show: true, reason: "unseen" }, "T2 未读时必须通知");

    // 手机/另一客户端只看到了 T1：不得清掉 T2 的自动未读。
    await service.setTaskUnread({
      taskId,
      workspacePath,
      unread: false,
      seenActivityAt: T1,
    });
    const afterSeenT1 = await repo.getTaskMeta(taskParams(workspacePath, taskId));
    assert.equal(afterSeenT1?.unreadAt, t2Marker, "seen(T1) 不得清掉更高终态 T2");
    assert.equal(afterSeenT1?.lastSeenActivityAt, T1);
    assert.equal(
      useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key],
      t2Marker,
      "手机 seen(T1) 广播后桌面绿点仍在",
    );
    const notifyAfterSeenT1 = await resolveTerminalNotificationDecision({
      taskId,
      workspacePath,
      terminalActivityAt: T2,
      service,
    });
    assert.deepEqual(notifyAfterSeenT1, { show: true, reason: "unseen" });

    // 看到 T2 后才允许清除并静音。
    await service.setTaskUnread({
      taskId,
      workspacePath,
      unread: false,
      seenActivityAt: T2,
    });
    const afterSeenT2 = await repo.getTaskMeta(taskParams(workspacePath, taskId));
    assert.equal(afterSeenT2?.unreadAt, undefined);
    assert.equal(afterSeenT2?.lastSeenActivityAt, T2);
    assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], null);
    assert.equal(
      getTaskUnreadIndicator(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
        taskId,
      ),
      false,
    );
    const notifyAfterSeenT2 = await resolveTerminalNotificationDecision({
      taskId,
      workspacePath,
      terminalActivityAt: T2,
      service,
    });
    assert.deepEqual(notifyAfterSeenT2, { show: false, reason: "seen" });
  }, meta);
});

test("真实 tasks-index：numeric 回包延迟期间手机已 seen，迟到回包不得复活绿点", async () => {
  resetQueryCache();
  const workspacePath = "/cross-client/workspace-late-response";
  const taskId = "task-cross-client-late-response";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  const meta = buildMeta({ workspacePath, taskId });

  await withRepo(async (repo) => {
    const baseService = createRepoBackedService(repo);
    let markCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      markCommitted = resolve;
    });
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const service: RepoBackedTaskService = {
      getTaskMeta: baseService.getTaskMeta,
      async setTaskUnread(params) {
        // Host 先提交并可能已广播，但回包被网络延迟。
        const committedMeta = await baseService.setTaskUnread(params);
        markCommitted();
        await responseGate;
        return committedMeta;
      },
    };

    const pendingSync = syncTaskUnreadFromStatusWorkspaceEvent({
      event: terminalStatusEvent({ workspacePath, taskId, terminalActivityAt: T2 }),
      service,
    });
    await committed;
    assert.ok(
      typeof (await repo.getTaskMeta(taskParams(workspacePath, taskId)))?.unreadAt === "number",
    );

    // 手机看到同一终态后上报已读；Host 广播空 unreadAt。
    await baseService.setTaskUnread({
      taskId,
      workspacePath,
      unread: false,
      seenActivityAt: T2,
    });
    assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], null);

    // 桌面迟到的 numeric 回包此刻才到达。
    releaseResponse();
    await pendingSync;

    assert.equal(
      useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key],
      null,
      "迟到回包必须被权威广播 stale-response guard 丢弃",
    );
    assert.equal(
      getTaskUnreadIndicator(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
        taskId,
      ),
      false,
    );
  }, meta);
});
