import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { setDataBaseDir } from "../src/paths.js";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

interface ServiceEvent {
  type: string;
  event?: unknown;
  [key: string]: unknown;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(false, "等待任务索引落库超时");
}

test("恢复期流事件不推进任务索引活动时间，只有用户 goal 变更推进", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-activity-time-"));
  setDataBaseDir(dir);
  const oldUpdatedAt = Date.now() - THREE_DAYS_MS;
  const meta = {
    taskId: "task-old",
    traceId: "trace-old",
    workspacePath: "/example/workspace",
    title: "三天前的任务",
    mode: "build" as const,
    provider: "glm" as const,
    createdAt: oldUpdatedAt - 1_000,
    updatedAt: oldUpdatedAt,
  };
  const taskIndexRepo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  await taskIndexRepo.syncTaskMeta({ meta });

  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const disposable = () => ({ dispose() {} });
  // 桩掉 agentService 的会话事件订阅：手动投递事件，模拟 CLI 冷恢复期间的流事件。
  let deliver: ((event: ServiceEvent) => void) | null = null;
  const service = createZCodeTaskServiceAdapter({
    taskIndexRepo,
    zcodeAgentService: {
      onDynamicSessionEvent() {
        return (listener: (event: ServiceEvent) => void) => {
          deliver = listener;
          return { dispose() {} };
        };
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  try {
    const received: ServiceEvent[] = [];
    const subscription = service.onDynamicTaskEvent({
      taskId: meta.taskId,
      workspacePath: meta.workspacePath,
    })((event) => received.push(event));
    const readMeta = () =>
      taskIndexRepo.getTaskMeta({ workspacePath: meta.workspacePath, taskId: meta.taskId });
    const deliverSessionEvent = (eventId: string, seq: number, payload: unknown) => {
      deliver?.({
        type: "session.event",
        event: {
          type: "session.updated",
          eventId,
          sessionId: meta.taskId,
          seq,
          timestamp: Date.now(),
          payload,
        },
      });
    };
    // goal 载荷必须满足 zcodeTaskGoalSchema 的必填项，否则整条 meta_json 会被判定非法。
    const goalPayload = (objective: string) => ({
      sessionID: meta.taskId,
      targetID: "goal-user",
      objective,
    });

    // 1) 冷恢复补发的 SessionTitleUpdated（payload 形状与 CLI resume.ts 一致）：
    //    标题照常落库（用不同标题证明 patch 确实生效），但活动时间必须保持原值。
    const restoredTitle = "三天前的任务（投影补发标题）";
    deliver?.({
      type: "session.event",
      event: {
        type: "session.titleUpdated",
        eventId: "evt-title-restore",
        sessionId: meta.taskId,
        seq: 1,
        timestamp: Date.now(),
        payload: { previousTitle: meta.title, source: "generated", title: restoredTitle },
      },
    });
    await waitFor(() => received.length > 0);
    await waitFor(async () => (await readMeta())?.title === restoredTitle);
    const afterTitle = await readMeta();
    assert.equal(afterTitle?.updatedAt, oldUpdatedAt, "标题补发不得推进 updatedAt");

    // 2) 用户 /goal（source: "command"）是真实用户活动，必须推进活动时间。
    //    这条同时锁住投影：若把 command 压扁成 runtime，活动时间就再也推不动了。
    const userGoalObjective = "用户设置的目标";
    deliverSessionEvent("evt-goal-command", 2, {
      target: goalPayload(userGoalObjective),
      action: "set",
      source: "command",
    });
    await waitFor(async () => (await readMeta())?.target?.objective === userGoalObjective);
    const afterUserGoal = await readMeta();
    assert.ok(
      afterUserGoal !== null && afterUserGoal.updatedAt > oldUpdatedAt,
      "用户 /goal 变更必须推进 updatedAt",
    );
    const userActivityAt = afterUserGoal.updatedAt;

    // 3) runtime 每轮 turn 的自动记账（run_started / usage_accounted / summary_updated）
    //    不是用户活动：goal 内容照常落库，活动时间必须不动。
    for (const [index, action] of ["run_started", "usage_accounted", "summary_updated"].entries()) {
      const objective = `runtime 记账 ${action}`;
      deliverSessionEvent(`evt-goal-${action}`, 3 + index, {
        target: goalPayload(objective),
        action,
        source: "runtime",
      });
      await waitFor(async () => (await readMeta())?.target?.objective === objective);
      assert.equal(
        (await readMeta())?.updatedAt,
        userActivityAt,
        `runtime 的 ${action} 不得推进 updatedAt`,
      );
    }

    // 4) 冷恢复合成事件的形态（action: "set", source: "runtime"）同样不推进。
    const hydrateObjective = "冷恢复合成的目标";
    deliverSessionEvent("evt-goal-hydrate", 6, {
      target: goalPayload(hydrateObjective),
      action: "set",
      source: "runtime",
    });
    await waitFor(async () => (await readMeta())?.target?.objective === hydrateObjective);
    assert.equal((await readMeta())?.updatedAt, userActivityAt, "冷恢复合成目标不得推进 updatedAt");

    // 5) runtime 清除 goal（target: null）也不推进。
    deliverSessionEvent("evt-goal-cleared", 7, { target: null, action: "cleared", source: "runtime" });
    await waitFor(async () => (await readMeta())?.target == null);
    assert.equal((await readMeta())?.updatedAt, userActivityAt, "runtime 清除目标不得推进 updatedAt");

    subscription.dispose();
  } finally {
    service.disposeAll();
    taskIndexRepo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
