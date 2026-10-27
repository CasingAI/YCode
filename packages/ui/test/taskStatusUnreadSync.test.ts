import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import { buildTaskEntityKey } from "../src/lib/taskQueryCache.js";
import {
  getInFlightTaskUnreadContextCountForTest,
  reconcileTaskMetaChangedEvent,
  syncTaskUnreadFromStatusWorkspaceEvent,
  type TaskStatusChangedEvent,
  type TaskUnreadDecisionService,
} from "../src/lib/taskStatusUnreadSync.js";
import { useTaskQueryCacheStore } from "../src/store/taskQueryCacheStore.js";
import { getTaskUnreadIndicator, useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

function decisionResult(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-decided",
    traceId: "trace-decided",
    title: "decided",
    workspacePath: "/workspace/decided",
    mode: "build",
    provider: "glm",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function statusEvent(params: {
  workspacePath: string;
  taskId: string;
  updatedAt: number;
  terminalActivityAt?: number;
  taskMetaUnreadAt?: number;
}): TaskStatusChangedEvent {
  return {
    type: "workspace_task_list_changed",
    workspacePath: params.workspacePath,
    taskId: params.taskId,
    reason: "task_status_changed",
    unreadSignal: "background_terminal",
    ...(params.terminalActivityAt === undefined
      ? {}
      : { terminalActivityAt: params.terminalActivityAt }),
    taskMeta: {
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      status: "completed",
      updatedAt: params.updatedAt,
      ...(params.taskMetaUnreadAt === undefined ? {} : { unreadAt: params.taskMetaUnreadAt }),
    } as ZCodeWorkspaceTaskListChanged["taskMeta"],
  };
}

function metaChangedEvent(params: {
  workspacePath: string;
  taskId: string;
  unreadAt?: number;
  lastSeenActivityAt?: number;
}): TaskStatusChangedEvent {
  return {
    type: "workspace_task_list_changed",
    workspacePath: params.workspacePath,
    taskId: params.taskId,
    reason: "task_meta_changed",
    taskMeta: {
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      status: "completed",
      updatedAt: 1,
      ...(params.unreadAt === undefined ? {} : { unreadAt: params.unreadAt }),
      ...(params.lastSeenActivityAt === undefined
        ? {}
        : { lastSeenActivityAt: params.lastSeenActivityAt }),
    } as ZCodeWorkspaceTaskListChanged["taskMeta"],
  };
}

function resetQueryCache(): void {
  useTaskQueryCacheStore.setState({
    taskMetaByEntityKey: {},
    taskUnreadOverlayByEntityKey: {},
  });
}

test("versioned 自动未读等待 Host 裁决，不先写乐观绿点", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/versioned";
  const taskId = "task-versioned";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  let resolveDecision!: (meta: ZCodeTaskMeta) => void;
  const calls: Parameters<TaskUnreadDecisionService["setTaskUnread"]>[0][] = [];
  const service: TaskUnreadDecisionService = {
    setTaskUnread: (params) => {
      calls.push(params);
      return new Promise((resolve) => {
        resolveDecision = resolve;
      });
    },
  };

  const pending = syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 100,
      terminalActivityAt: 100,
    }),
    service,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.unread, true);
  assert.equal(calls[0]?.terminalActivityAt, 100, "必须把终态活动版本交给 Host 裁决");
  assert.equal(
    useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key],
    undefined,
    "Host 回包前不得有乐观绿点",
  );
  assert.equal(
    getTaskUnreadIndicator(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    ),
    false,
  );

  resolveDecision(decisionResult({ unreadAt: 123 }));
  await pending;
  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], 123);
});

test("Host 裁决为已见时不产生绿点", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/seen";
  const taskId = "task-seen";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  const service: TaskUnreadDecisionService = {
    setTaskUnread: async () => decisionResult(),
  };

  await syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 101,
      terminalActivityAt: 101,
    }),
    service,
  });

  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], null);
  assert.equal(
    getTaskUnreadIndicator(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    ),
    false,
  );
});

test("Host 请求失败不制造 renderer-only 未读", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/failure";
  const taskId = "task-failure";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  const service: TaskUnreadDecisionService = {
    setTaskUnread: async () => {
      throw new Error("disconnected");
    },
  };

  await syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 102,
      terminalActivityAt: 102,
    }),
    service,
  });

  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], undefined);
  assert.equal(
    getTaskUnreadIndicator(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    ),
    false,
  );
});

test("legacy 事件没有终态版本时保留旧 Host 路径", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/legacy";
  const taskId = "task-legacy";
  const calls: Parameters<TaskUnreadDecisionService["setTaskUnread"]>[0][] = [];
  const service: TaskUnreadDecisionService = {
    setTaskUnread: async (params) => {
      calls.push(params);
      return decisionResult({ unreadAt: 200 });
    },
  };

  await syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({ workspacePath, taskId, updatedAt: 103 }),
    service,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.unread, true);
  assert.equal("terminalActivityAt" in (calls[0] ?? {}), false);
});

test("legacy 事件已携带 Host unreadAt 时直接对账，不再重复写", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/carried";
  const taskId = "task-carried";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  let called = false;
  const service: TaskUnreadDecisionService = {
    setTaskUnread: async () => {
      called = true;
      return decisionResult();
    },
  };

  await syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 104,
      taskMetaUnreadAt: 300,
    }),
    service,
  });

  assert.equal(called, false);
  // 事件已携带 Host marker 时不重复落库，也不创建永久 optimistic overlay；
  // 兼容 Dock badge 仍走既有迁移期投影。
  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], undefined);
  assert.equal(
    getTaskUnreadIndicator(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    ),
    true,
  );
});

test("task_meta_changed 清除其他端已读后释放本端数值 overlay", () => {
  resetQueryCache();
  const workspacePath = "/workspace/meta-cleared";
  const taskId = "task-meta-cleared";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  // 本端先有后台终态数值 overlay；其他客户端读完会话后 Host 广播
  // task_meta_changed（unreadAt 为空）。若不处理，mergeIncomingTaskListItem
  // 会让旧数值 overlay 一直压过已清除的 unreadAt，桌面绿点不消失。
  useTaskQueryCacheStore.getState().reconcileTaskUnread({ taskId, workspacePath }, 300);
  useZCodeSessionStore.getState().setTaskUnreadIndicator(workspacePath, taskId, true);

  reconcileTaskMetaChangedEvent(metaChangedEvent({ workspacePath, taskId }));

  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], null);
  // 兼容 Dock/旧 badge 也必须跟随权威事件熄灭。
  assert.equal(
    getTaskUnreadIndicator(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    ),
    false,
  );
});

test("task_meta_changed 携带新 marker 时把 overlay 对齐到 Host 值", () => {
  resetQueryCache();
  const workspacePath = "/workspace/meta-updated";
  const taskId = "task-meta-updated";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  useTaskQueryCacheStore.getState().reconcileTaskUnread({ taskId, workspacePath }, 300);

  reconcileTaskMetaChangedEvent(metaChangedEvent({ workspacePath, taskId, unreadAt: 500 }));

  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], 500);
});

test("非 task_meta_changed 事件不触碰未读 overlay", () => {
  resetQueryCache();
  const workspacePath = "/workspace/meta-ignored";
  const taskId = "task-meta-ignored";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  useTaskQueryCacheStore.getState().reconcileTaskUnread({ taskId, workspacePath }, 300);

  reconcileTaskMetaChangedEvent(
    statusEvent({ workspacePath, taskId, updatedAt: 105, terminalActivityAt: 105 }),
  );

  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], 300);
});

test("versioned 已有旧未读也必须再次交给 Host，并区分同 updatedAt 的两次完成", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/versioned-t2";
  const taskId = "task-versioned-t2";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  const calls: Parameters<TaskUnreadDecisionService["setTaskUnread"]>[0][] = [];
  const service: TaskUnreadDecisionService = {
    setTaskUnread: async (params) => {
      calls.push(params);
      return decisionResult({
        unreadAt: params.terminalActivityAt === 100 ? 301 : 302,
      });
    },
  };

  // T1 未读已落库且缓存/事件都携带 301。旧实现会在这里直接 return，
  // 导致 T2 完成无法推进 Host 的 unread_activity_at。
  useTaskQueryCacheStore.getState().reconcileTaskUnread({ taskId, workspacePath }, 301);

  await syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 500,
      terminalActivityAt: 100,
      taskMetaUnreadAt: 301,
    }),
    service,
  });
  await syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 500,
      terminalActivityAt: 200,
      taskMetaUnreadAt: 301,
    }),
    service,
  });

  assert.equal(calls.length, 2, "两个终态都必须经 Host 裁决");
  assert.equal(calls[0]?.terminalActivityAt, 100);
  assert.equal(calls[1]?.terminalActivityAt, 200);
  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], 302);
});

test("versioned 不信任 cached/event marker：Host 裁决已读时立即熄灭绿点", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/versioned-seen";
  const taskId = "task-versioned-seen";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  useTaskQueryCacheStore.getState().reconcileTaskUnread({ taskId, workspacePath }, 900);
  useZCodeSessionStore.getState().setTaskUnreadIndicator(workspacePath, taskId, true);
  let called = 0;
  const service: TaskUnreadDecisionService = {
    setTaskUnread: async () => {
      called += 1;
      // Host 水位已覆盖该终态：不返回 marker。
      return decisionResult();
    },
  };

  await syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 501,
      terminalActivityAt: 200,
      taskMetaUnreadAt: 900,
    }),
    service,
  });

  assert.equal(called, 1, "versioned 事件不能因旧 marker 短路");
  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], null);
  assert.equal(
    getTaskUnreadIndicator(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    ),
    false,
  );
});

test("迟到 numeric 回包不得复活手机 seen 已清除的绿点", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/versioned-late-seen";
  const taskId = "task-versioned-late-seen";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  let resolveDecision!: (meta: ZCodeTaskMeta) => void;
  const service: TaskUnreadDecisionService = {
    setTaskUnread: () =>
      new Promise((resolve) => {
        resolveDecision = resolve;
      }),
  };

  const pending = syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 502,
      terminalActivityAt: 200,
    }),
    service,
  });

  // 手机在看到 T=200 后上报已读，Host 广播 task_meta_changed(unreadAt 为空)。
  reconcileTaskMetaChangedEvent(
    metaChangedEvent({ workspacePath, taskId, lastSeenActivityAt: 200 }),
  );
  assert.equal(
    useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key],
    null,
    "权威广播先清绿点",
  );

  // 桌面先前发出的 unread 请求此刻才回包（numeric），必须被 stale-response guard 丢弃。
  resolveDecision(decisionResult({ unreadAt: 999 }));
  await pending;

  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], null);
  assert.equal(
    getTaskUnreadIndicator(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    ),
    false,
  );
});

test("迟到回包期间到达更高终态的权威 marker 时，以更高 marker 为准", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/versioned-late-t2";
  const taskId = "task-versioned-late-t2";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  let resolveDecision!: (meta: ZCodeTaskMeta) => void;
  const service: TaskUnreadDecisionService = {
    setTaskUnread: () =>
      new Promise((resolve) => {
        resolveDecision = resolve;
      }),
  };

  const pending = syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 503,
      terminalActivityAt: 100,
    }),
    service,
  });

  // T1 请求在途时，T2 的自动未读广播先到。
  reconcileTaskMetaChangedEvent(metaChangedEvent({ workspacePath, taskId, unreadAt: 500 }));

  // T1 的迟到回包 marker 更小，不得把 overlay 回退到 400。
  resolveDecision(decisionResult({ unreadAt: 400 }));
  await pending;

  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], 500);
});

test("versioned 请求失败不回滚并覆盖并发到达的新事实", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/versioned-failure";
  const taskId = "task-versioned-failure";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  let rejectDecision!: (error: Error) => void;
  const service: TaskUnreadDecisionService = {
    setTaskUnread: () =>
      new Promise((_resolve, reject) => {
        rejectDecision = reject;
      }),
  };

  const pending = syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 504,
      terminalActivityAt: 100,
    }),
    service,
  });

  // 请求在途期间，另一条权威广播带来更新的未读 marker。
  reconcileTaskMetaChangedEvent(metaChangedEvent({ workspacePath, taskId, unreadAt: 800 }));

  rejectDecision(new Error("disconnected"));
  await pending;

  // 新路径没有乐观写，失败时不得 rollback 掉 800。
  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], 800);
  assert.equal(
    getTaskUnreadIndicator(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    ),
    true,
  );
});

test("回包确认已读且无 marker 时，期间到达的旧 numeric 广播不复活绿点", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/versioned-old-broadcast";
  const taskId = "task-versioned-old-broadcast";
  const key = buildTaskEntityKey({ workspacePath, taskId });
  let resolveDecision!: (meta: ZCodeTaskMeta) => void;
  const service: TaskUnreadDecisionService = {
    setTaskUnread: () =>
      new Promise((resolve) => {
        resolveDecision = resolve;
      }),
  };

  const pending = syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 505,
      terminalActivityAt: 100,
    }),
    service,
  });

  // 一条更早的 numeric 广播延迟到此期间才送达。
  reconcileTaskMetaChangedEvent(metaChangedEvent({ workspacePath, taskId, unreadAt: 700 }));

  // 回包提交更晚：无 marker 且水位已覆盖本次终态。
  resolveDecision(decisionResult({ lastSeenActivityAt: 100 }));
  await pending;

  assert.equal(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[key], null);
  assert.equal(
    getTaskUnreadIndicator(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath),
      taskId,
    ),
    false,
  );
});

test("versioned 回包结束后不保留在途权威上下文", async () => {
  resetQueryCache();
  const workspacePath = "/workspace/no-leftover-context";
  const taskId = "task-no-leftover-context";
  const key = buildTaskEntityKey({ workspacePath, taskId });

  const successService: TaskUnreadDecisionService = {
    setTaskUnread: async () => decisionResult({ unreadAt: 1 }),
  };
  await syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 506,
      terminalActivityAt: 100,
    }),
    service: successService,
  });
  assert.equal(getInFlightTaskUnreadContextCountForTest(key), 0);

  const failureService: TaskUnreadDecisionService = {
    setTaskUnread: async () => {
      throw new Error("disconnected");
    },
  };
  await syncTaskUnreadFromStatusWorkspaceEvent({
    event: statusEvent({
      workspacePath,
      taskId,
      updatedAt: 507,
      terminalActivityAt: 200,
    }),
    service: failureService,
  });
  assert.equal(getInFlightTaskUnreadContextCountForTest(key), 0, "失败路径也必须清理登记");
});
