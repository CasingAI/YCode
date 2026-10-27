import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  createTaskSeenReporter,
  isTerminalActivitySeen,
  resolveTerminalNotificationDecision,
  selectTaskSeenActivityAt,
  type TaskReadWatermarkQueryService,
  type TaskReadableSnapshot,
} from "../src/lib/taskReadWatermark.js";

function metaWithSeen(lastSeenActivityAt?: number): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    traceId: "trace-task-1",
    title: "task-1",
    workspacePath: "/workspace",
    mode: "build",
    provider: "glm",
    createdAt: 1,
    updatedAt: 2,
    ...(lastSeenActivityAt === undefined ? {} : { lastSeenActivityAt }),
  };
}

function readableSnapshot(
  phase: TaskReadableSnapshot["control"]["phase"],
  lastActivityAt?: number,
): TaskReadableSnapshot {
  return {
    control: { phase },
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
  };
}

const ALL_GATES = {
  visible: true,
  documentVisible: true,
  contiguousToTail: true,
  following: true,
  readOnly: false,
  selectionSideChat: false,
} as const;

test("仅当终态快照且所有可见/跟随条件都满足时才上报活动版本", () => {
  assert.equal(
    selectTaskSeenActivityAt({
      snapshot: readableSnapshot("completedSuccess", 120),
      ...ALL_GATES,
    }),
    120,
  );
  assert.equal(
    selectTaskSeenActivityAt({
      snapshot: readableSnapshot("completedInterrupted", 121),
      ...ALL_GATES,
    }),
    121,
  );
  assert.equal(
    selectTaskSeenActivityAt({
      snapshot: readableSnapshot("error", 122),
      ...ALL_GATES,
    }),
    122,
  );

  for (const phase of ["draft", "prewarming", "running"] as const) {
    assert.equal(
      selectTaskSeenActivityAt({
        snapshot: readableSnapshot(phase, 120),
        ...ALL_GATES,
      }),
      undefined,
      `phase=${phase} 不得确认已读`,
    );
  }
});

test("隐藏、后台、未到 tail、上滚、只读、副屏都不推进水位", () => {
  const snapshot = readableSnapshot("completedSuccess", 120);
  const gates = ["visible", "documentVisible", "contiguousToTail", "following"] as const;
  for (const gate of gates) {
    assert.equal(
      selectTaskSeenActivityAt({
        snapshot,
        ...ALL_GATES,
        [gate]: false,
      }),
      undefined,
      `${gate}=false 不得确认已读`,
    );
  }
  assert.equal(
    selectTaskSeenActivityAt({
      snapshot,
      ...ALL_GATES,
      readOnly: true,
    }),
    undefined,
  );
  assert.equal(
    selectTaskSeenActivityAt({
      snapshot,
      ...ALL_GATES,
      selectionSideChat: true,
    }),
    undefined,
  );
  assert.equal(
    selectTaskSeenActivityAt({
      snapshot: readableSnapshot("completedSuccess"),
      ...ALL_GATES,
    }),
    undefined,
    "旧快照没有 activity 版本时不得伪造已读",
  );
  assert.equal(
    selectTaskSeenActivityAt({
      snapshot: null,
      ...ALL_GATES,
    }),
    undefined,
  );
});

test("活动版本必须是正安全整数，0/负数/小数/NaN 与 Host 一致视为无版本", () => {
  for (const invalid of [0, -1, 120.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      selectTaskSeenActivityAt({
        snapshot: readableSnapshot("completedSuccess", invalid),
        ...ALL_GATES,
      }),
      undefined,
      `lastActivityAt=${String(invalid)} 不得上报`,
    );
    assert.equal(
      isTerminalActivitySeen({ lastSeenActivityAt: 200, terminalActivityAt: invalid }),
      false,
    );
    assert.equal(
      isTerminalActivitySeen({ lastSeenActivityAt: invalid, terminalActivityAt: 120 }),
      false,
    );
  }
});

test("水位覆盖终态才判为已读", () => {
  assert.equal(isTerminalActivitySeen({ lastSeenActivityAt: 120, terminalActivityAt: 120 }), true);
  assert.equal(isTerminalActivitySeen({ lastSeenActivityAt: 121, terminalActivityAt: 120 }), true);
  assert.equal(isTerminalActivitySeen({ lastSeenActivityAt: 119, terminalActivityAt: 120 }), false);
  assert.equal(
    isTerminalActivitySeen({ lastSeenActivityAt: undefined, terminalActivityAt: 120 }),
    false,
  );
  assert.equal(
    isTerminalActivitySeen({ lastSeenActivityAt: 120, terminalActivityAt: undefined }),
    false,
  );
});

test("seen 上报串行化：in-flight 时只保留最大待发版本，完成后补发", async () => {
  const sent: number[] = [];
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const reporter = createTaskSeenReporter({
    send: async (activityAt) => {
      sent.push(activityAt);
      if (sent.length === 1) await firstDone;
    },
  });

  reporter.report(10);
  reporter.report(10);
  reporter.report(12);
  reporter.report(11);
  // 第一次发送在微任务中启动（用于规避 send 同步 throw 的 in-flight 竞态）。
  await Promise.resolve();
  assert.deepEqual(sent, [10]);

  releaseFirst();
  await reporter.awaitIdle();
  await reporter.awaitIdle();
  assert.deepEqual(sent, [10, 12]);

  reporter.report(12);
  reporter.report(9);
  assert.deepEqual(sent, [10, 12], "重复/更旧版本不得重复上报");
});

test("上报失败不推进成功水位，下一次更大版本仍可上报", async () => {
  const sent: number[] = [];
  let shouldFail = true;
  const reporter = createTaskSeenReporter({
    send: async (activityAt) => {
      sent.push(activityAt);
      if (shouldFail) throw new Error("boom");
    },
  });

  reporter.report(10);
  await reporter.awaitIdle();
  shouldFail = false;
  reporter.report(20);
  await reporter.awaitIdle();

  assert.deepEqual(sent, [10, 20]);
});

test("send 同步 throw 后必须清空 in-flight，后续 report 仍能继续发送", async () => {
  const sent: number[] = [];
  const errors: Array<{ activityAt: number; error: unknown }> = [];
  const reporter = createTaskSeenReporter({
    send: (activityAt) => {
      sent.push(activityAt);
      if (activityAt === 10) {
        // 同步抛错，不能把 inFlight 留在一个已 fulfilled 的 Promise 上。
        throw new Error("sync boom");
      }
      return Promise.resolve();
    },
    onError: (error, activityAt) => errors.push({ activityAt, error }),
  });

  reporter.report(10);
  await reporter.awaitIdle();
  reporter.report(20);
  await reporter.awaitIdle();

  assert.deepEqual(sent, [10, 20]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.activityAt, 10);
});

test("dispose 后不再上报", async () => {
  const sent: number[] = [];
  const reporter = createTaskSeenReporter({
    send: async (activityAt) => {
      sent.push(activityAt);
    },
  });
  reporter.dispose();
  reporter.report(10);
  await reporter.awaitIdle();
  assert.deepEqual(sent, []);
});

test("通知裁决：已读水位覆盖终态时不通知", async () => {
  const service: TaskReadWatermarkQueryService = {
    getTaskMeta: async () => metaWithSeen(120),
  };
  const decision = await resolveTerminalNotificationDecision({
    taskId: "task-1",
    workspacePath: "/workspace",
    terminalActivityAt: 120,
    service,
    isCurrent: () => true,
  });
  assert.deepEqual(decision, { show: false, reason: "seen" });
});

test("通知裁决：新终态未被水位覆盖时仍通知", async () => {
  const service: TaskReadWatermarkQueryService = {
    getTaskMeta: async () => metaWithSeen(120),
  };
  const decision = await resolveTerminalNotificationDecision({
    taskId: "task-1",
    workspacePath: "/workspace",
    terminalActivityAt: 121,
    service,
    isCurrent: () => true,
  });
  assert.deepEqual(decision, { show: true, reason: "unseen" });
});

test("通知裁决：无有效终态版本时保留旧通知行为", async () => {
  for (const terminalActivityAt of [undefined, 0, -1, 120.5]) {
    const decision = await resolveTerminalNotificationDecision({
      taskId: "task-1",
      workspacePath: "/workspace",
      ...(terminalActivityAt === undefined ? {} : { terminalActivityAt }),
      service: { getTaskMeta: async () => metaWithSeen(200) },
      isCurrent: () => true,
    });
    assert.deepEqual(decision, { show: true, reason: "no_terminal_version" });
  }
});

test("通知裁决：查询失败保留现有通知行为", async () => {
  const service: TaskReadWatermarkQueryService = {
    getTaskMeta: async () => {
      throw new Error("disconnected");
    },
  };
  const decision = await resolveTerminalNotificationDecision({
    taskId: "task-1",
    workspacePath: "/workspace",
    terminalActivityAt: 120,
    service,
    isCurrent: () => true,
  });
  assert.equal(decision.show, true);
  assert.equal(decision.reason, "query_failed");
});

test("通知裁决：先 await 本端 in-flight seen，再读 Host 水位", async () => {
  let releaseSeen!: () => void;
  const seenDone = new Promise<void>((resolve) => {
    releaseSeen = resolve;
  });
  let metaRead = false;
  const service: TaskReadWatermarkQueryService = {
    getTaskMeta: async () => {
      metaRead = true;
      return metaWithSeen(120);
    },
  };

  const pending = resolveTerminalNotificationDecision({
    taskId: "task-1",
    workspacePath: "/workspace",
    terminalActivityAt: 120,
    service,
    awaitPendingSeen: () => seenDone,
    isCurrent: () => true,
  });

  await Promise.resolve();
  assert.equal(metaRead, false, "seen 请求未完成前不得先读水位");

  releaseSeen();
  const decision = await pending;
  assert.equal(metaRead, true);
  assert.deepEqual(decision, { show: false, reason: "seen" });
});

test("通知裁决：代际失效后丢弃陈旧结果", async () => {
  let current = true;
  const service: TaskReadWatermarkQueryService = {
    getTaskMeta: async () => {
      current = false;
      return metaWithSeen(120);
    },
  };
  const decision = await resolveTerminalNotificationDecision({
    taskId: "task-1",
    workspacePath: "/workspace",
    terminalActivityAt: 120,
    service,
    isCurrent: () => current,
  });
  assert.deepEqual(decision, { show: false, reason: "stale" });
});
