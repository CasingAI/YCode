import assert from "node:assert/strict";
import test from "node:test";
import { EventReducer } from "../../contracts/src/events/event-reducer.js";
import { SessionEventType } from "../../contracts/src/events/session.events.js";
import { resolveExecutionState } from "@zcode/shared";
import {
  applyRuntimeExecutionState,
  readRuntimeExecutionState,
} from "../src/runtime/execution-state.js";
import { grantPermissionFullAccess } from "../src/runtime/permission-full-access.js";
import { resolveRestoredExecutionState } from "../src/runtime/methods/resume.js";

// 计划执行目标（docs/specs/plan-card-execute.md / team-mode.md）：
// - 唯一来源是进入 Plan 时的当前档：Team → team，其余 → yolo；
// - 命令输入只接受 mode，不信任载荷里的 planExecuteMode；
// - 离开 Plan（普通切档 / 全访问授权）必须清空，重复进入幂等。

const SESSION_ID = "session-plan-execute-mode" as never;

interface ApplyHarness {
  runtime: never;
  entries: unknown[];
  events: unknown[];
}

function createApplyRuntime(initialMode: "plan" | "readonly" | "yolo" | "team"): ApplyHarness {
  const entries: unknown[] = [];
  const events: unknown[] = [];
  const runtime = {
    sessionId: SESSION_ID,
    config: { mode: initialMode },
    permissionFullAccessPending: false,
    sessionPersisted: true,
    sessionStore: {
      saveSessionEntry: async (entry: unknown) => {
        entries.push(entry);
      },
    },
    rootTraceContext: { queryId: "query-1" },
    readSessionTargetForContext: async () => null,
    createEvent: (type: unknown, data: unknown) => ({ type, payload: data }),
    appendEvent: async (event: unknown) => {
      events.push(event);
    },
  };
  return { runtime: runtime as never, entries, events };
}

function entryData(entry: unknown): unknown {
  return (entry as { data?: unknown }).data;
}

function eventPayload(event: unknown): Record<string, unknown> {
  return (event as { payload: Record<string, unknown> }).payload;
}

test("Team → Plan：派生 team，先落盘再改内存再发事件", async () => {
  const { runtime, entries, events } = createApplyRuntime("team");

  const next = await applyRuntimeExecutionState(runtime, { mode: "plan" }, { source: "command" });

  assert.deepEqual(next, { mode: "plan", planExecuteMode: "team" });
  assert.deepEqual(entryData(entries[0]), { mode: "plan", planExecuteMode: "team" });
  assert.equal((runtime as { config: { planExecuteMode?: string } }).config.planExecuteMode, "team");
  assert.equal(eventPayload(events[0]).planExecuteMode, "team");
  assert.equal(eventPayload(events[0]).mode, "plan");
});

test("Agent / Ask → Plan：目标统一为 yolo", async () => {
  for (const source of ["yolo", "readonly"] as const) {
    const { runtime, entries, events } = createApplyRuntime(source);
    await applyRuntimeExecutionState(runtime, { mode: "plan" }, { source: "command" });
    assert.deepEqual(entryData(entries[0]), { mode: "plan", planExecuteMode: "yolo" }, source);
    assert.equal(eventPayload(events[0]).planExecuteMode, "yolo", source);
  }
});

test("命令载荷自带的 planExecuteMode 不可信：来源仍是 Current 档", async () => {
  const { runtime, entries } = createApplyRuntime("yolo");

  await applyRuntimeExecutionState(
    runtime,
    { mode: "plan", planExecuteMode: "team" } as { mode: string },
    { source: "command" },
  );

  assert.deepEqual(entryData(entries[0]), { mode: "plan", planExecuteMode: "yolo" });
});

test("Plan 内重复进入幂等：不重写目标、不落盘、不发事件", async () => {
  const harness = createApplyRuntime("plan");
  (harness.runtime as { config: Record<string, unknown> }).config.planExecuteMode = "team";

  const next = await applyRuntimeExecutionState(
    harness.runtime,
    { mode: "plan" },
    { source: "tool" },
  );

  assert.deepEqual(next, { mode: "plan", planExecuteMode: "team" });
  assert.equal(harness.entries.length, 0);
  assert.equal(harness.events.length, 0);
});

test("离开 Plan：清空目标，事件与 entry 都不再携带", async () => {
  const harness = createApplyRuntime("plan");
  const config = (harness.runtime as { config: Record<string, unknown> }).config;
  config.planExecuteMode = "team";

  await applyRuntimeExecutionState(harness.runtime, { mode: "yolo" }, { source: "command" });

  assert.deepEqual(entryData(harness.entries[0]), { mode: "yolo" });
  assert.equal("planExecuteMode" in config, false);
  assert.equal("planExecuteMode" in eventPayload(harness.events[0]), false);
});

test("runtime 读取保留已落定的目标，不被 resolve(config) 重算成 yolo", () => {
  const runtime = { config: { mode: "plan", planExecuteMode: "team" } } as never;
  assert.deepEqual(readRuntimeExecutionState(runtime), {
    mode: "plan",
    planExecuteMode: "team",
  });
  // 旧数据缺字段：Plan 内按 yolo 兼容。
  assert.deepEqual(readRuntimeExecutionState({ config: { mode: "plan" } } as never), {
    mode: "plan",
    planExecuteMode: "yolo",
  });
});

test("stable fork 历史目标：只按历史消息的 mode 派生，Plan 一律 yolo", () => {
  // session-fork 对历史消息走 resolveExecutionState(info)，不会读父会话当前目标。
  assert.deepEqual(resolveExecutionState({ mode: "plan" }), {
    mode: "plan",
    planExecuteMode: "yolo",
  });
  assert.deepEqual(resolveExecutionState({ mode: "team" }), { mode: "team" });
  // 没有历史 assistant 的 stable fork 也不能拿父当前 Team 目标冒充历史来源。
  const parent = readRuntimeExecutionState({
    config: { mode: "plan", planExecuteMode: "team" },
  } as never);
  assert.deepEqual(resolveExecutionState({ mode: parent.mode }), {
    mode: "plan",
    planExecuteMode: "yolo",
  });
});

test("resume：entry 优先于事件，目标随 mode 一起恢复", () => {
  assert.deepEqual(
    resolveRestoredExecutionState({
      savedExecutionData: { mode: "plan", planExecuteMode: "team" },
      restoredMode: "yolo",
    }),
    { mode: "plan", planExecuteMode: "team" },
  );
  assert.deepEqual(
    resolveRestoredExecutionState({
      restoredMode: "plan",
      restoredPlanExecuteMode: "team",
    }),
    { mode: "plan", planExecuteMode: "team" },
  );
  // 旧事件缺目标：Plan 内按 yolo 兼容，不从 previousMode 猜。
  assert.deepEqual(resolveRestoredExecutionState({ restoredMode: "plan" }), {
    mode: "plan",
    planExecuteMode: "yolo",
  });
});

test("resume：显式 modeOverride 视为重新入场，不沿用存储目标", () => {
  const saved = { mode: "plan", planExecuteMode: "team" };
  assert.deepEqual(
    resolveRestoredExecutionState({ modeOverride: "yolo", savedExecutionData: saved }),
    { mode: "yolo" },
  );
  assert.deepEqual(
    resolveRestoredExecutionState({ modeOverride: "plan", savedExecutionData: saved }),
    { mode: "plan", planExecuteMode: "yolo" },
  );
  assert.deepEqual(
    resolveRestoredExecutionState({ modeOverride: "team", savedExecutionData: saved }),
    { mode: "team" },
  );
});

test("resume：没有任何权威来源时不伪造执行状态", () => {
  assert.equal(resolveRestoredExecutionState({}), undefined);
});

interface FullAccessHarness {
  runtime: never;
  committed: { execution?: { data?: unknown } } | undefined;
  events: unknown[];
}

function createFullAccessRuntime(): FullAccessHarness {
  const harness: FullAccessHarness = {
    runtime: undefined as never,
    committed: undefined,
    events: [],
  };
  const runtime = {
    sessionId: SESSION_ID,
    config: { mode: "plan", planExecuteMode: "team" },
    permissionFullAccessPending: false,
    pendingInputReservations: new Map(),
    pendingInputDrains: 0,
    rootTraceContext: { queryId: "query-1" },
    activeTurn: undefined,
    sessionStore: {
      sessionEntries: async () => [],
      commitPermissionFullAccess: async (input: unknown) => {
        harness.committed = input as { execution?: { data?: unknown } };
      },
    },
    rebuildProjection: async () => ({ pendingSteerInputs: [] }),
    createEvent: (type: unknown, data: unknown) => ({ id: "event-1", type, payload: data }),
    eventStore: { getEvents: async () => [] },
    appendEvent: async (event: unknown) => {
      harness.events.push(event);
    },
    notifyEventSinks: async () => {},
  };
  harness.runtime = runtime as never;
  return harness;
}

test("全访问授权是离开 Plan 的写入点：entry、事件与内存都清空目标", async () => {
  const harness = createFullAccessRuntime();

  await grantPermissionFullAccess.call(harness.runtime, "interaction-1");

  assert.deepEqual(harness.committed?.execution?.data, { mode: "yolo" });
  assert.equal(
    (harness.runtime as { config: Record<string, unknown> }).config.planExecuteMode,
    undefined,
  );
  assert.equal("planExecuteMode" in eventPayload(harness.events[0]), false);
});

test("SessionModeChanged 投影保留 Plan 目标，离开 Plan 时清理", () => {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  const base = {
    id: "event",
    sessionId: SESSION_ID,
    timestamp,
  };
  const reducer = new EventReducer();
  const created = reducer.reduce([
    {
      ...base,
      type: SessionEventType.SessionCreated,
      payload: { mode: "team", contextWindow: 100_000 },
    } as never,
  ]);
  assert.equal(created.planExecuteMode, undefined);

  const entered = reducer.apply(created, {
    ...base,
    type: SessionEventType.SessionModeChanged,
    payload: { mode: "plan", planExecuteMode: "team", previousMode: "team", source: "command" },
  } as never);
  assert.equal(entered.planExecuteMode, "team");

  const oldPlanEvent = reducer.apply(created, {
    ...base,
    type: SessionEventType.SessionModeChanged,
    payload: { mode: "plan", previousMode: "team", source: "command" },
  } as never);
  assert.equal(oldPlanEvent.planExecuteMode, "yolo");

  const left = reducer.apply(entered, {
    ...base,
    type: SessionEventType.SessionModeChanged,
    payload: { mode: "yolo", previousMode: "plan", source: "command" },
  } as never);
  assert.equal(left.planExecuteMode, undefined);
});
