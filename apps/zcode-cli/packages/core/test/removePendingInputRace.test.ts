// 撤回（deleteQueueItem → removePendingInputById）与模型步边界 drain 的原子胜负边界。
// 这些用例调用真实 steering 实现，只用可控 sessionStore / persistUserPrompt 复现 await 窗口。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  PendingTurnInput,
  SessionId,
  SessionInputRecord,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ActiveTurnSteeringState } from "../src/runtime/types.js";
import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  discardHeldPendingInputById,
  drainPendingInput,
  removePendingInputById,
} from "../src/runtime/methods/steering.js";

const SESSION_ID = "session_withdraw_race" as SessionId;
const TURN_ID = "turn_withdraw_race" as TurnId;
const TRACE: TraceContext = { traceId: "trace-withdraw-race" as TraceContext["traceId"] };

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pendingInput(id: string): PendingTurnInput {
  return {
    id,
    input: `text-${id}`,
    queuedAt: new Date(0),
    traceId: "trace-withdraw-race" as TraceContext["traceId"],
    delivery: "guide",
    turnId: TURN_ID,
  };
}

function createHarness(options: {
  ids: readonly string[];
  /** 投影里可见的 pendingSteerInputs；drain/discard 事件提交后会同步摘除。 */
  projectionIds?: readonly string[];
  settleGate?: Promise<void>;
  settleError?: unknown;
  appendError?: unknown;
  persistGate?: Promise<void>;
  onPersist?: (input: string) => void;
}) {
  const events: SessionEvent[] = [];
  const persisted: string[] = [];
  const settled: Array<{ id: string; status: string; reason?: string }> = [];
  const projectionIds = [...(options.projectionIds ?? [])];
  const activeTurn = {
    kind: "regular",
    goalStateChangeReminderDeferralOpen: false,
    pendingInputs: options.ids.map(pendingInput),
    steerable: true,
    traceContext: TRACE,
    turnId: TURN_ID,
  } as ActiveTurnSteeringState;
  const removeProjected = (ids: readonly string[]) => {
    for (const id of ids) {
      const index = projectionIds.indexOf(id);
      if (index >= 0) projectionIds.splice(index, 1);
    }
  };
  const runtime = {
    sessionId: SESSION_ID,
    activeTurn,
    pendingInputReservations: new Map<string, string>(),
    pendingInputDrains: 0,
    pendingInputDrainIds: new Set<string>(),
    permissionFullAccessPending: false,
    queueExternalDrainActive: false,
    logger: undefined,
    messageHistory: { addEntries: () => {} },
    sessionStore: {
      settleSessionInput: async (input: {
        id: string;
        status: SessionInputRecord["status"];
        reason?: string;
      }) => {
        settled.push(input);
        if (options.settleError) throw options.settleError;
        if (options.settleGate) await options.settleGate;
      },
    },
    appendEvent: async (event: SessionEvent) => {
      if (options.appendError) throw options.appendError;
      events.push(event);
      if (event.type === SessionEventType.TurnSteerDrained) {
        removeProjected((event.payload as { pendingInputIds: string[] }).pendingInputIds ?? []);
      }
      if (event.type === SessionEventType.TurnSteerDiscarded) {
        removeProjected((event.payload as { pendingInputIds: string[] }).pendingInputIds ?? []);
      }
    },
    createEvent: (type: string, payload: unknown) => ({
      type,
      payload,
      sessionId: SESSION_ID,
      timestamp: new Date(),
    }),
    persistUserPrompt: async (_messageId: unknown, input: string) => {
      options.onPersist?.(input);
      if (options.persistGate) await options.persistGate;
      persisted.push(input);
    },
    rebuildProjection: async () => ({
      pendingSteerInputs: projectionIds.map((id) => ({
        pendingInputId: id,
        targetTurnId: TURN_ID,
      })),
    }),
    discardHeldPendingInputById,
  } as unknown as AgentRuntimeInternal;
  return { runtime, activeTurn, events, persisted, settled, projectionIds };
}

function idsOf(activeTurn: ActiveTurnSteeringState): string[] {
  return activeTurn.pendingInputs.map((item) => item.id);
}

function discardedIds(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === SessionEventType.TurnSteerDiscarded
      ? ((event.payload as { pendingInputIds: string[] }).pendingInputIds ?? [])
      : [],
  );
}

test("撤回持有 reservation 时 drain 不得消费，且只删除目标项", async () => {
  const gate = deferred();
  const h = createHarness({ ids: ["A", "B"], settleGate: gate.promise });

  const removing = removePendingInputById.call(h.runtime, {
    pendingInputId: "A",
    reason: "user_removed",
    traceContext: TRACE,
  });

  // 让撤回走到 settle 的 await；此时 reservation 必须已同步落锁。
  await Promise.resolve();
  const drained = await drainPendingInput.call(h.runtime, {
    activeTurn: h.activeTurn,
    events: [],
    traceContext: TRACE,
  });

  gate.resolve();
  const removed = await removing;

  assert.equal(removed, true);
  assert.deepEqual(idsOf(h.activeTurn), ["B"], "不得误删相邻 pending input");
  assert.deepEqual(discardedIds(h.events), ["A"]);
  assert.deepEqual(h.persisted, [], "撤回成功后模型不得再消费该输入");
  assert.equal(drained, undefined, "reservation 必须阻止 drain");
  assert.deepEqual(
    h.settled.map((item) => item.id),
    ["A"],
  );
});

test("真实 drain 的 persist await 窗口内撤回：不得按 held 取消或回填", async () => {
  const persistStarted = deferred();
  const persistGate = deferred();
  const h = createHarness({
    ids: ["A", "B"],
    projectionIds: ["A", "B"],
    onPersist: () => persistStarted.resolve(),
    persistGate: persistGate.promise,
  });

  const draining = drainPendingInput.call(h.runtime, {
    activeTurn: h.activeTurn,
    events: [],
    traceContext: TRACE,
  });
  await persistStarted.promise;

  // drain 已 splice A 并进入持久化；TurnSteerDrained 尚未提交，投影仍显示 A。
  assert.deepEqual(idsOf(h.activeTurn), ["B"]);
  assert.deepEqual(h.projectionIds, ["A", "B"]);

  const removed = await removePendingInputById.call(h.runtime, {
    pendingInputId: "A",
    reason: "user_removed",
    traceContext: TRACE,
  });

  assert.equal(removed, false, "正在消费的项不得被当成 held 撤回");
  assert.deepEqual(h.settled, [], "账本不得被改成 cancelled");
  assert.deepEqual(discardedIds(h.events), []);

  persistGate.resolve();
  const diagnostics = await draining;
  assert.deepEqual(diagnostics?.pendingInputIds, ["A"]);
  assert.deepEqual(h.persisted, ["text-A"]);
  assert.deepEqual(h.projectionIds, ["B"], "drain 提交后投影才摘除");
});

test("drain 窗口内 active turn 已结束时，仍不得把该项当 held 撤回", async () => {
  const persistStarted = deferred();
  const persistGate = deferred();
  const h = createHarness({
    ids: ["A"],
    projectionIds: ["A"],
    onPersist: () => persistStarted.resolve(),
    persistGate: persistGate.promise,
  });

  const draining = drainPendingInput.call(h.runtime, {
    activeTurn: h.activeTurn,
    events: [],
    traceContext: TRACE,
  });
  await persistStarted.promise;
  h.runtime.activeTurn = undefined;

  const removed = await removePendingInputById.call(h.runtime, {
    pendingInputId: "A",
    reason: "user_removed",
    traceContext: TRACE,
  });
  assert.equal(removed, false);
  assert.deepEqual(h.settled, []);

  persistGate.resolve();
  await draining;
  assert.deepEqual(h.persisted, ["text-A"]);
});

test("active turn 内 enqueue 的 held 项仍可撤回（不按 drain 误杀）", async () => {
  const h = createHarness({ ids: ["B"], projectionIds: ["A"] });
  assert.deepEqual(idsOf(h.activeTurn), ["B"]);
  assert.notEqual(h.activeTurn.turnId, undefined);

  const removed = await removePendingInputById.call(h.runtime, {
    pendingInputId: "A",
    reason: "user_removed",
    traceContext: TRACE,
  });

  assert.equal(removed, true);
  assert.deepEqual(
    h.settled.map((item) => [item.id, item.status]),
    [["A", "cancelled"]],
  );
  assert.deepEqual(discardedIds(h.events), ["A"]);
});

test("active turn 已结束时 held 项仍可撤回", async () => {
  const h = createHarness({ ids: [], projectionIds: ["A"] });
  h.runtime.activeTurn = undefined;

  const removed = await removePendingInputById.call(h.runtime, {
    pendingInputId: "A",
    reason: "user_removed",
    traceContext: TRACE,
  });

  assert.equal(removed, true);
  assert.deepEqual(discardedIds(h.events), ["A"]);
});

test("settle 失败时不删除输入、释放自有 reservation，后续 drain 仍可消费", async () => {
  const h = createHarness({
    ids: ["A", "B"],
    settleError: new Error("session_input write failed"),
  });

  await assert.rejects(
    removePendingInputById.call(h.runtime, {
      pendingInputId: "A",
      reason: "user_removed",
      traceContext: TRACE,
    }),
    /session_input write failed/,
  );

  assert.deepEqual(idsOf(h.activeTurn), ["A", "B"], "失败不得静默丢失输入");
  assert.equal(h.runtime.pendingInputReservations.size, 0, "自有 reservation 必须释放");
  assert.deepEqual(discardedIds(h.events), []);

  const drained = await drainPendingInput.call(h.runtime, {
    activeTurn: h.activeTurn,
    events: [],
    traceContext: TRACE,
  });
  assert.deepEqual(drained?.pendingInputIds, ["A"]);
  assert.deepEqual(idsOf(h.activeTurn), ["B"]);
});

test("目标项已不在 active turn 且投影也查不到：撤回 noop，不结算账本", async () => {
  const h = createHarness({ ids: ["B"] });
  const removed = await removePendingInputById.call(h.runtime, {
    pendingInputId: "A",
    reason: "user_removed",
    traceContext: TRACE,
  });

  assert.equal(removed, false);
  assert.deepEqual(h.settled, [], "drain 获胜后不得把账本改成 cancelled");
  assert.deepEqual(idsOf(h.activeTurn), ["B"]);
});

test("caller 已持有 reservation 时沿用其锁，成功后仍只删目标项", async () => {
  const h = createHarness({ ids: ["A", "B"] });
  h.runtime.pendingInputReservations.set("A", "promote-lease");

  const removed = await removePendingInputById.call(h.runtime, {
    pendingInputId: "A",
    reason: "promoted",
    reservationId: "promote-lease",
    traceContext: TRACE,
  });

  assert.equal(removed, true);
  assert.deepEqual(idsOf(h.activeTurn), ["B"]);
  assert.deepEqual(discardedIds(h.events), ["A"]);
  assert.equal(h.settled.length, 0, "promoted 只摘队列，不结算账本");
  assert.equal(h.runtime.pendingInputReservations.size, 0);
});

test("事件写失败：自有 reservation 不泄漏，caller reservation 保留", async () => {
  const owned = createHarness({ ids: ["A", "B"], appendError: new Error("append failed") });
  await assert.rejects(
    removePendingInputById.call(owned.runtime, {
      pendingInputId: "A",
      reason: "user_removed",
      traceContext: TRACE,
    }),
    /append failed/,
  );
  assert.deepEqual(idsOf(owned.activeTurn), ["B"]);
  assert.equal(owned.runtime.pendingInputReservations.size, 0, "自有锁必须释放");
  assert.deepEqual(
    owned.settled.map((item) => item.id),
    ["A"],
  );

  const leased = createHarness({ ids: ["A", "B"], appendError: new Error("append failed") });
  leased.runtime.pendingInputReservations.set("A", "promote-lease");
  await assert.rejects(
    removePendingInputById.call(leased.runtime, {
      pendingInputId: "A",
      reason: "promoted",
      reservationId: "promote-lease",
      traceContext: TRACE,
    }),
    /append failed/,
  );
  assert.equal(
    leased.runtime.pendingInputReservations.get("A"),
    "promote-lease",
    "caller 锁不能由撤回释放",
  );
});

test("他人持有 reservation 时拒绝撤回，不结算账本", async () => {
  const h = createHarness({ ids: ["A", "B"] });
  h.runtime.pendingInputReservations.set("A", "other-lease");

  const removed = await removePendingInputById.call(h.runtime, {
    pendingInputId: "A",
    reason: "user_removed",
    traceContext: TRACE,
  });

  assert.equal(removed, false);
  assert.deepEqual(idsOf(h.activeTurn), ["A", "B"]);
  assert.deepEqual(h.settled, []);
  assert.deepEqual(discardedIds(h.events), []);
});
