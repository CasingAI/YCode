// 手动 /compact 与 /rewind 的成功终态/Stop 单一裁决（真实 executeManualCompact /
// executeRewindCommand）。
//
// 两者都是 executeTurnCommand 的早退入口，复用 success-terminal-admission：
//   - 业务 await 期间 Stop 必须取消，不落 success；
//   - 成功事件准入后 Stop 只能 noop，且不 abort；
//   - 成功提交后的 usage/rebuild 故障或部分提交不再追加矛盾终态；
//   - 真正没写进权威事件流的失败仍保留错误终态；
//   - compact 的 preserveQueueAutoDrainOnCancel 授权不被改写。
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent, SessionId, TraceContext, TurnId } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ActiveForegroundExecutionState, ParsedRewindCommand } from "../src/runtime/types.js";
import { executeManualCompact } from "../src/runtime/methods/compact.js";
import { executeRewindCommand } from "../src/runtime/methods/rewind.js";
import { stopActiveForegroundExecution } from "../src/runtime/methods/runtime-command-queue.js";

type MaintenanceKind = "compact" | "rewind";

const SESSION_ID = "session-maintenance-stop" as SessionId;
const TURN_ID = "turn_maintenance_stop" as TurnId;
const TRACE: TraceContext = {
  sessionId: SESSION_ID,
  traceId: "trace-maintenance-stop" as TraceContext["traceId"],
  turnId: TURN_ID,
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface GateControl {
  businessStarted?: Deferred;
  businessGate?: Deferred;
  businessError?: unknown;
  turnCompleteAppendStarted?: Deferred;
  turnCompleteAppend?: Deferred;
  usageStarted?: Deferred;
  usageGate?: Deferred;
  projectionStarted?: Deferred;
  projectionGate?: Deferred;
  projectionError?: unknown;
  failEventType?: SessionEventType;
  failAfterStore?: boolean;
}

interface MaintenanceHarness {
  appended: SessionEvent[];
  control: GateControl;
  execution: ActiveForegroundExecutionState;
  runtime: AgentRuntimeInternal;
  stored: SessionEvent[];
  usageStatuses: string[];
  queueAutoDrain: boolean;
  queueExternalDrainActive: boolean;
}

function createExecution(): ActiveForegroundExecutionState {
  return {
    controller: new AbortController(),
    disposeParentAbort: () => {},
    foregroundExecutionId: "exec-maintenance-stop",
    preserveQueueAutoDrainOnCancel: false,
    successTerminalAdmitted: false,
    yieldRequests: new Map(),
    yieldDependents: new Map(),
  };
}

function createMaintenanceHarness(kind: MaintenanceKind): MaintenanceHarness {
  const appended: SessionEvent[] = [];
  const stored: SessionEvent[] = [];
  const control: GateControl = {};
  const execution = createExecution();
  const usageStatuses: string[] = [];
  let eventSequence = 0;

  const runtime = {
    sessionId: SESSION_ID,
    config: { taskType: "agent" },
    activeForegroundExecution: execution,
    turnNumber: 1,
    sessionPersisted: true,
    queueAutoDrain: true,
    queueExternalDrainActive: true,
    messageHistory: {
      getCacheStats: () => ({ hitRate: 0, cachedTokens: 0 }),
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    beginActiveTurn: () => ({}) as never,
    finishActiveTurn: () => {},
    ensureSessionPersisted: async () => {},
    createEvent: (
      type: SessionEventType,
      payload: Record<string, unknown>,
      traceContext: TraceContext,
    ) => {
      eventSequence += 1;
      return {
        id: `maintenance_event_${eventSequence}`,
        payload,
        sequenceNumber: 0,
        sessionId: SESSION_ID,
        timestamp: new Date(1000 + eventSequence),
        traceId: traceContext.traceId,
        turnId: traceContext.turnId,
        type,
      } as SessionEvent;
    },
    appendEvent: async (event: SessionEvent) => {
      if (event.type === SessionEventType.TurnComplete) {
        control.turnCompleteAppendStarted?.resolve();
        await control.turnCompleteAppend?.promise;
      }
      if (control.failEventType === event.type) {
        if (control.failAfterStore) {
          stored.push(event);
        }
        throw new Error(`append rejected: ${event.type}`);
      }
      appended.push(event);
      stored.push(event);
    },
    eventStore: {
      append: async (event: SessionEvent) => ({ ...event, sequenceNumber: stored.length + 1 }),
      getEvents: async () => stored,
    },
    sessionStore: {
      recordModelUsage: async () => {},
      upsertToolUsage: async () => {},
      upsertTurnUsage: async (input: { status: string }) => {
        usageStatuses.push(input.status);
        control.usageStarted?.resolve();
        await control.usageGate?.promise;
      },
      pruneUsage: async () => {},
    },
    compactActiveConversation: async () => {
      control.businessStarted?.resolve();
      await control.businessGate?.promise;
      if (control.businessError) throw control.businessError;
      return { displayText: "compact summary", tokenCount: 12 };
    },
    // rewind 使用 action=status 分支，避免触碰隔离 fixture 之外的 workspace 文件。
    formatRewindStatus: async () => {
      control.businessStarted?.resolve();
      await control.businessGate?.promise;
      if (control.businessError) throw control.businessError;
      return "rewind status";
    },
    rebuildProjection: async () => {
      control.projectionStarted?.resolve();
      await control.projectionGate?.promise;
      if (control.projectionError) throw control.projectionError;
      return {} as never;
    },
  } as unknown as AgentRuntimeInternal;

  const harness: MaintenanceHarness = {
    appended,
    control,
    execution,
    runtime,
    stored,
    usageStatuses,
    get queueAutoDrain() {
      return (runtime as unknown as { queueAutoDrain: boolean }).queueAutoDrain;
    },
    set queueAutoDrain(value: boolean) {
      (runtime as unknown as { queueAutoDrain: boolean }).queueAutoDrain = value;
    },
    get queueExternalDrainActive() {
      return (runtime as unknown as { queueExternalDrainActive: boolean }).queueExternalDrainActive;
    },
  };
  // kind 只用于表达同一套 harness 覆盖两个早退入口；两者运行时依赖一致。
  void kind;
  return harness;
}

function runMaintenance(kind: MaintenanceKind, harness: MaintenanceHarness): Promise<unknown> {
  const signal = harness.execution.controller.signal;
  if (kind === "compact") {
    return executeManualCompact.call(
      harness.runtime,
      "compact this conversation",
      "focus on decisions",
      TURN_ID,
      TRACE,
      signal,
      "input-compact",
    );
  }
  const command: ParsedRewindCommand = { action: "status" };
  return executeRewindCommand.call(
    harness.runtime,
    "rewind status",
    command,
    TURN_ID,
    TRACE,
    signal,
    "input-rewind",
  );
}

function stop(harness: MaintenanceHarness, preserveQueueAutoDrainOnCancel = false) {
  return stopActiveForegroundExecution.call(harness.runtime, {
    expectedForegroundExecutionId: harness.execution.foregroundExecutionId,
    preserveQueueAutoDrainOnCancel,
  });
}

function countTurnComplete(events: readonly SessionEvent[], resultType: "success" | "cancelled") {
  return events.filter(
    (event) =>
      event.type === SessionEventType.TurnComplete &&
      (event.payload as { resultType?: string }).resultType === resultType,
  ).length;
}

function countTurnError(events: readonly SessionEvent[]) {
  return events.filter((event) => event.type === SessionEventType.TurnError).length;
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected maintenance command rejection");
    },
    (error: unknown) => error,
  );
}

for (const kind of ["compact", "rewind"] as const) {
  test(`${kind}: 准入前 Stop 只收 cancelled，不落 success`, async () => {
    const harness = createMaintenanceHarness(kind);
    harness.control.businessStarted = deferred();
    harness.control.businessGate = deferred();
    const run = runMaintenance(kind, harness);

    await harness.control.businessStarted.promise;
    const stopped = stop(harness);
    assert.equal(stopped.kind, "stopped");
    assert.equal(harness.execution.controller.signal.aborted, true);

    harness.control.businessGate.resolve();
    await rejection(run);

    assert.equal(countTurnComplete(harness.appended, "success"), 0);
    assert.equal(countTurnComplete(harness.appended, "cancelled"), 1);
    assert.equal(countTurnError(harness.appended), 0);
    assert.equal(harness.execution.successTerminalAdmitted, false);
    if (kind === "compact") {
      // 用户 stop 保持既有语义：队列重新暂停。
      assert.equal(harness.queueAutoDrain, false);
      assert.equal(harness.queueExternalDrainActive, false);
    } else {
      // /rewind 不改 compact 专属的队列授权位。
      assert.equal(harness.queueAutoDrain, true);
      assert.equal(harness.queueExternalDrainActive, true);
    }
  });

  test(`${kind}: 成功准入后 Stop 返回 completed，只落一个 success`, async () => {
    const harness = createMaintenanceHarness(kind);
    harness.control.turnCompleteAppendStarted = deferred();
    harness.control.turnCompleteAppend = deferred();
    const run = runMaintenance(kind, harness);

    await harness.control.turnCompleteAppendStarted.promise;
    assert.equal(harness.execution.successTerminalAdmitted, true);
    const stopped = stop(harness);
    assert.deepEqual(stopped, {
      kind: "completed",
      foregroundExecutionId: harness.execution.foregroundExecutionId,
    });
    assert.equal(harness.execution.controller.signal.aborted, false);
    assert.equal(harness.execution.preserveQueueAutoDrainOnCancel, false);

    harness.control.turnCompleteAppend.resolve();
    const result = await run;
    assert.equal((result as { response: string }).response.length > 0, true);

    assert.equal(countTurnComplete(harness.appended, "success"), 1);
    assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
    assert.equal(countTurnError(harness.appended), 0);
    assert.equal(harness.execution.successTerminalAdmitted, false);
    assert.deepEqual(harness.usageStatuses, ["completed"]);

    // 阶段保护必须释放：命令返回后同一 execution 可以再次被 Stop。
    const afterReturn = stop(harness);
    assert.equal(afterReturn.kind, "stopped");
  });

  test(`${kind}: success 提交后 usage/rebuild await 中 Stop 仍是 completed`, async () => {
    const harness = createMaintenanceHarness(kind);
    harness.control.usageStarted = deferred();
    harness.control.usageGate = deferred();
    harness.control.projectionStarted = deferred();
    harness.control.projectionGate = deferred();
    const run = runMaintenance(kind, harness);

    // 成功事件已提交，但 usage 记账还没结束；此时的 Stop 不能 abort 或改写终态。
    await harness.control.usageStarted.promise;
    assert.equal(countTurnComplete(harness.stored, "success"), 1);
    assert.equal(stop(harness).kind, "completed");
    harness.control.usageGate.resolve();

    // rebuildProjection 同样处于成功提交保护范围内。
    await harness.control.projectionStarted.promise;
    assert.equal(stop(harness).kind, "completed");
    harness.control.projectionGate.resolve();

    await run;
    assert.equal(harness.execution.controller.signal.aborted, false);
    assert.equal(countTurnComplete(harness.appended, "success"), 1);
    assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
    assert.equal(countTurnError(harness.appended), 0);
  });

  test(`${kind}: 成功提交后 postwork 真失败不追加矛盾终态`, async () => {
    const harness = createMaintenanceHarness(kind);
    harness.control.projectionError = new Error("projection exploded");
    const run = runMaintenance(kind, harness);

    const error = await rejection(run);
    assert.equal((error as Error).message, `${kind === "compact" ? "Compact" : "Rewind"} failed`);
    const cause = (error as Error).cause;
    assert.equal(cause instanceof Error ? cause.message : "", "projection exploded");

    assert.equal(countTurnComplete(harness.appended, "success"), 1);
    assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
    assert.equal(countTurnError(harness.appended), 0);
    assert.deepEqual(harness.usageStatuses, ["completed"]);
    assert.equal(harness.execution.successTerminalAdmitted, false);
  });

  test(`${kind}: success 部分提交后 append 拒绝，不再追加终态`, async () => {
    const harness = createMaintenanceHarness(kind);
    harness.control.failEventType = SessionEventType.TurnComplete;
    harness.control.failAfterStore = true;
    const run = runMaintenance(kind, harness);

    await rejection(run);

    // 成功事件已进入权威事件流（stored），只能保留它，不能再写 cancelled/TurnError。
    assert.equal(countTurnComplete(harness.stored, "success"), 1);
    assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
    assert.equal(countTurnError(harness.appended), 0);
    assert.equal(harness.execution.successTerminalAdmitted, false);
  });

  test(`${kind}: success 完全未写入时仍收口真实错误`, async () => {
    const harness = createMaintenanceHarness(kind);
    harness.control.failEventType = SessionEventType.TurnComplete;
    harness.control.failAfterStore = false;
    const run = runMaintenance(kind, harness);

    await rejection(run);

    assert.equal(countTurnComplete(harness.stored, "success"), 0);
    assert.equal(countTurnComplete(harness.appended, "success"), 0);
    assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
    assert.equal(countTurnError(harness.appended), 1);
    assert.equal(harness.execution.successTerminalAdmitted, false);
  });
}

test("compact: 内部抢占 preserve 授权在 cancelled 收口中保留", async () => {
  const harness = createMaintenanceHarness("compact");
  harness.control.businessStarted = deferred();
  harness.control.businessGate = deferred();
  const run = runMaintenance("compact", harness);

  await harness.control.businessStarted.promise;
  const stopped = stop(harness, true);
  assert.equal(stopped.kind, "stopped");
  harness.control.businessGate.resolve();
  await rejection(run);

  const cancelled = harness.appended.find(
    (event) =>
      event.type === SessionEventType.TurnComplete &&
      (event.payload as { resultType?: string }).resultType === "cancelled",
  );
  assert.ok(cancelled);
  assert.equal(
    (cancelled.payload as { preserveQueueAutoDrainOnCancel?: boolean })
      .preserveQueueAutoDrainOnCancel,
    true,
  );
  // 内部抢占不能误关原队列授权，避免 outer FIFO 恢复窗口被关闭。
  assert.equal(harness.queueAutoDrain, true);
  assert.equal(harness.queueExternalDrainActive, true);
});
