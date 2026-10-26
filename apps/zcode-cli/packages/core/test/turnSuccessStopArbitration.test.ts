// 成功终态与 Stop 的单一裁决（真实 executeTurnCommand）。
//
// 这些用例不复用 helper 的 truth table，而是把真实 turn 跑到收尾阶段，用 deferred
// 精确停在不同 await 上：
//   - accounting / 浏览器截图期间 Stop 仍必须生效；
//   - TurnComplete(success) 已准入后 Stop 只能 noop；
//   - 事件已提交后不再追加第二个终态。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageId,
  SessionEvent,
  SessionGoal,
  SessionId,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ActiveForegroundExecutionState } from "../src/runtime/types.js";
import { executeTurnCommand } from "../src/runtime/methods/turn.js";
import { stopActiveForegroundExecution } from "../src/runtime/methods/runtime-command-queue.js";
import {
  appendEvent as appendEventReal,
  isSessionEventStoredError,
} from "../src/runtime/methods/events.js";
import { verifyActiveTargetCompletionForContinuation } from "../src/runtime/methods/target-completion-verification.js";
import { createExternalTurnFaultError } from "../src/runtime/helpers/turn-errors.js";
import { recordBrowserTurnToolResult } from "../src/repl/browser-turn-state.js";

const SESSION_ID = "session-success-stop" as SessionId;
const TURN_ID = "turn_success_stop" as TurnId;
const TRACE: TraceContext = {
  sessionId: SESSION_ID,
  traceId: "trace-success-stop" as TraceContext["traceId"],
  turnId: TURN_ID,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface GateControl {
  accounting?: ReturnType<typeof deferred>;
  projection?: ReturnType<typeof deferred>;
  screenshot?: ReturnType<typeof deferred>;
  turnCompleteAppend?: ReturnType<typeof deferred>;
  turnCompleteAppendStarted?: ReturnType<typeof deferred>;
  modelCompleteAppend?: ReturnType<typeof deferred>;
  modelUsage?: ReturnType<typeof deferred>;
  verificationAppend?: ReturnType<typeof deferred>;
  targetPersistence?: ReturnType<typeof deferred>;
  modelCompleteAppendStarted?: ReturnType<typeof deferred>;
  modelUsageStarted?: ReturnType<typeof deferred>;
  verificationAppendStarted?: ReturnType<typeof deferred>;
  targetPersistenceStarted?: ReturnType<typeof deferred>;
  userPromptHooks?: ReturnType<typeof deferred>;
  userPromptHooksStarted?: ReturnType<typeof deferred>;
  generateStarted?: ReturnType<typeof deferred>;
  generateGate?: ReturnType<typeof deferred>;
  /** 模拟 postwork 真失败。 */
  projectionError?: unknown;
  /** 模拟 completed verification append 真失败。 */
  failCompletedVerification?: boolean;
  /** 让指定事件在“已写入 eventStore”后拒绝，模拟部分提交。 */
  failEventType?: SessionEventType;
  failAfterStore?: boolean;
  /** preventContinuation 分支：hook 返回阻止继续。 */
  preventContinuation?: boolean;
  /** 使用真实 events.ts appendEvent 处理成功终态。 */
  realTurnCompleteAppend?: boolean;
  /** 真实 appendEvent 在 notify sinks 阶段失败。 */
  failNotifySinks?: boolean;
  /** 让 eventStore 回查失败，证明 committed 判定来自错误标记而不是回查。 */
  failEventRead?: boolean;
}

interface TurnHarness {
  appended: SessionEvent[];
  control: GateControl;
  execution: ActiveForegroundExecutionState;
  runtime: AgentRuntimeInternal;
  stored: SessionEvent[];
}

function createExecution(): ActiveForegroundExecutionState {
  return {
    controller: new AbortController(),
    disposeParentAbort: () => {},
    foregroundExecutionId: "exec-success-stop",
    preserveQueueAutoDrainOnCancel: false,
    successTerminalAdmitted: false,
    yieldRequests: new Map(),
    yieldDependents: new Map(),
  };
}

function createTurnHarness(): TurnHarness {
  const appended: SessionEvent[] = [];
  const stored: SessionEvent[] = [];
  const control: GateControl = {};
  const execution = createExecution();
  let eventSequence = 0;

  const telemetryScope = () => ({
    finishCancelled: () => {},
    finishCompleted: () => {},
    finishFailed: () => {},
    run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    setResultType: () => {},
  });

  const runtime = {
    sessionId: SESSION_ID,
    turnNumber: 1,
    branchGeneration: 1,
    rootTraceContext: TRACE,
    now: () => new Date(2000),
    workingDirectory: "C:/workspace",
    workspaceRoot: "C:/workspace",
    contextInitialized: false,
    sessionPersisted: true,
    shuttingDown: false,
    latestConversationMessageId: "msg_assistant" as MessageId,
    latestAssistantMessageId: "msg_assistant" as MessageId,
    latestAssistantTurnId: TURN_ID,
    sessionTitleGenerationAttempted: true,
    queueAutoDrain: true,
    queueExternalDrainActive: false,
    pendingInputSequence: 0,
    pendingInputReservations: new Map(),
    residentBlockingWorkCount: 0,
    residencyBlockingWorkCount: 0,
    autoCompactConsecutiveFailures: 0,
    sessionCacheHitAggregate: {},
    currentTurnFileChanges: new Map(),
    config: { taskType: "agent" },
    activeForegroundExecution: execution,
    messageHistory: {
      addEntries: () => {},
      addUser: () => {},
      borrowReadOnlyRuntimeEntries: () => [],
      getCacheStats: () => ({}),
      setCacheHit: () => {},
      setCacheMiss: () => {},
    },
    agentTelemetry: {
      captureCausation: () => undefined,
      detached: telemetryScope,
      step: telemetryScope,
      turn: telemetryScope,
    },
    createEvent: (
      type: SessionEventType,
      payload: Record<string, unknown>,
      traceContext: TraceContext,
    ) => {
      eventSequence += 1;
      return {
        id: `event_${eventSequence}`,
        payload,
        sequenceNumber: 0,
        sessionId: SESSION_ID,
        timestamp: new Date(1000 + eventSequence),
        traceId: traceContext.traceId,
        turnId: traceContext.turnId,
        type,
      } as SessionEvent;
    },
    appendEvent: async (event: SessionEvent, traceContext?: TraceContext) => {
      if (event.type === SessionEventType.TurnComplete && control.turnCompleteAppend) {
        control.turnCompleteAppendStarted?.resolve();
        await control.turnCompleteAppend.promise;
      }
      if (event.type === SessionEventType.TurnComplete && control.realTurnCompleteAppend) {
        // 真实 events.ts appendEvent：event_store.append 成功后，notify 阶段抛错，
        // 用于验证 SESSION_EVENT_STORED_ERROR 的“已提交”判定，而不是 fake append。
        runtime.eventSinks = control.failNotifySinks
          ? ({
              [Symbol.iterator]() {
                throw new Error("notify sink failure");
              },
            } as never)
          : ([] as never);
        return appendEventReal.call(runtime, event, traceContext ?? TRACE);
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
      append: async (event: SessionEvent) => {
        const storedEvent = { ...event, sequenceNumber: stored.length + 1 };
        stored.push(storedEvent);
        return storedEvent;
      },
      getEvents: async () => {
        if (control.failEventRead) {
          throw new Error("event store read failed");
        }
        return stored;
      },
    },
    sessionStore: {
      messages: async () => [],
      saveMessage: async () => {},
      updateTargetStatus: async () => null,
    },
    getSessionModelSelection: () => ({ modelId: "test-model", providerId: "test-provider" }),
    modelFactory: () => ({
      providerId: "test-provider",
      modelId: "test-model",
      displayName: "test-model",
      properties: { contextWindow: 200_000, inputFormat: "text" },
      optionSpecs: { maxOutputTokens: { max: 64_000 } },
      options: {},
      bind() {
        return this;
      },
      generateText: async () => ({ text: "done", usage: {}, finish: "stop" }),
      streamText: () => {
        throw new Error("not used");
      },
    }),
    ensureContextInitialized: async () => {},
    ensureSessionPersisted: async () => {},
    runSessionStartHooks: async () => ({ additionalContexts: [] }),
    runUserPromptSubmitHooks: async () => {
      control.userPromptHooksStarted?.resolve();
      await control.userPromptHooks?.promise;
      return {
        additionalContexts: [],
        ...(control.preventContinuation
          ? { preventContinuation: true, stopReason: "blocked by hook" }
          : {}),
      };
    },
    injectHookAdditionalContextIntoMessageHistory: () => undefined,
    persistUserPrompt: async () => {},
    persistPendingModelChangeTimeline: async () => {},
    persistSyntheticUserNoticeForSession: async () => {},
    injectPluginReferenceReminderFromTurn: () => undefined,
    readSessionTargetForContext: async () => null,
    startTargetTurnAccounting: async () => null,
    accountTargetTurnCompletion: async () => {
      await control.accounting?.promise;
    },
    finishTargetTurnAccounting: async () => null,
    pauseActiveTargetForCancellation: async () => {},
    recordTargetChanged: async () => {},
    persistAssistantMessage: async () => ({}),
    persistPart: async () => {},
    logModelRequestSteeringContext: () => {},
    runModelTextRequest: async () => ({
      finish: "stop",
      parts: [],
      text: "done",
      usage: {},
    }),
    extractToolCallsFromResult: () => [],
    microcompactIfNeeded: async () => false,
    autoCompactIfNeeded: async () => false,
    reactiveCompactAfterContextExceeded: async () => false,
    initializeMcp: async () => {},
    getTools: () => [],
    getMode: () => "yolo",
    readSessionTodosForContext: async () => "",
    drainPendingRuntimeCommandsForActiveLoop: async () => ({
      backgroundSubagentResultConsumed: false,
      consumedCommandIds: [],
      drained: 0,
      messageIds: [],
      runtimeEntries: [],
      workflowResultConsumed: false,
    }),
    runStopHooks: async () => undefined,
    shouldContinueAfterStopHooks: () => false,
    fallbackPendingGuidesToQueue: async () => {},
    hasInlineGuidePendingInput: () => false,
    takeInlineGuidePendingInput: () => undefined,
    beginActiveTurn: (turnId: TurnId) => ({
      inputId: "input-1",
      kind: "regular",
      pendingInputs: [],
      steerable: true,
      turnId,
    }),
    finishActiveTurn: () => {},
    reserveTurnStart: () => {},
    releaseTurnStart: () => {},
    rebuildProjection: async () => {
      await control.projection?.promise;
      if (control.projectionError) {
        throw control.projectionError;
      }
      return {
        pendingSteerInputs: [],
        targetCompletionVerificationTimeline: [],
      } as never;
    },
    browserControlPort: {
      execute: async (request: { command: { method: string } }) => {
        if (request.command.method === "list") {
          await control.screenshot?.promise;
          return {
            ok: true,
            tabs: [{ active: true, tabId: "tab-1" }],
          } as never;
        }
        return {
          image: { base64: "aGVsbG8=", mimeType: "image/png" },
          ok: true,
        } as never;
      },
      turnEnded: async () => {},
    },
    turnStartedAtMs: Date.now(),
  } as unknown as AgentRuntimeInternal;

  return { appended, control, execution, runtime, stored };
}

function makeReservation() {
  return {
    kind: "regular" as const,
    traceContext: TRACE,
    turnId: TURN_ID,
  };
}

function countTurnComplete(
  events: readonly SessionEvent[],
  resultType: "success" | "cancelled",
): number {
  return events.filter(
    (event) =>
      event.type === SessionEventType.TurnComplete &&
      (event.payload as { resultType?: string }).resultType === resultType,
  ).length;
}

function stop(harness: Pick<TurnHarness, "execution" | "runtime">) {
  return stopActiveForegroundExecution.call(harness.runtime, {
    expectedForegroundExecutionId: harness.execution.foregroundExecutionId,
  });
}

test("Stop 落在 accounting await：只收口 cancelled，success 不落库", async () => {
  const harness = createTurnHarness();
  harness.control.accounting = deferred();
  const run = executeTurnCommand.call(
    harness.runtime,
    "do the thing",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  await new Promise((resolve) => setImmediate(resolve));
  const stopped = stop(harness);
  assert.deepEqual(stopped, {
    kind: "stopped",
    foregroundExecutionId: harness.execution.foregroundExecutionId,
  });
  harness.control.accounting.resolve();
  await assert.rejects(run);

  assert.equal(countTurnComplete(harness.appended, "cancelled"), 1);
  assert.equal(countTurnComplete(harness.appended, "success"), 0);
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("Stop 落在浏览器截图 await：仍可 cancelled，证明没有提前准入", async () => {
  const harness = createTurnHarness();
  harness.control.screenshot = deferred();
  recordBrowserTurnToolResult({
    output: {
      _meta: {
        "zcode/browserTurnScreenshot": { browserGeneration: 1, browserId: "browser-1" },
      },
    },
    sessionId: SESSION_ID,
    toolName: "js",
    turnId: TURN_ID,
  });
  const run = executeTurnCommand.call(
    harness.runtime,
    "take a screenshot",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  await new Promise((resolve) => setImmediate(resolve));
  const stopped = stop(harness);
  assert.equal(stopped.kind, "stopped");
  harness.control.screenshot.resolve();
  await assert.rejects(run);

  assert.equal(countTurnComplete(harness.appended, "cancelled"), 1);
  assert.equal(countTurnComplete(harness.appended, "success"), 0);
});

test("TurnComplete 已准入后 Stop 返回 completed，不 abort 且只落一个 success", async () => {
  const harness = createTurnHarness();
  harness.control.turnCompleteAppend = deferred();
  const run = executeTurnCommand.call(
    harness.runtime,
    "finish the thing",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.execution.successTerminalAdmitted, true);
  const stopped = stop(harness);
  assert.deepEqual(stopped, {
    kind: "completed",
    foregroundExecutionId: harness.execution.foregroundExecutionId,
  });
  assert.equal(harness.execution.controller.signal.aborted, false);
  harness.control.turnCompleteAppend.resolve();
  await run;

  assert.equal(countTurnComplete(harness.appended, "success"), 1);
  assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("success 已提交后的 cleanup 中 Stop 仍是 completed，不产生第二终态", async () => {
  const harness = createTurnHarness();
  harness.control.projection = deferred();
  const run = executeTurnCommand.call(
    harness.runtime,
    "finish and project",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(countTurnComplete(harness.appended, "success"), 1);
  const stopped = stop(harness);
  assert.equal(stopped.kind, "completed");
  harness.control.projection.resolve();
  await run;

  assert.equal(countTurnComplete(harness.appended, "success"), 1);
  assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
});

test("success 事件部分提交后 append 拒绝：不再追加 cancelled", async () => {
  const harness = createTurnHarness();
  harness.control.failEventType = SessionEventType.TurnComplete;
  harness.control.failAfterStore = true;
  const run = executeTurnCommand.call(
    harness.runtime,
    "partial commit",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  await assert.rejects(run);
  assert.equal(harness.stored.at(-1)?.type, SessionEventType.TurnComplete);
  assert.equal(countTurnComplete(harness.stored, "success"), 1);
  assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
  assert.equal(countTurnComplete(harness.appended, "success"), 0);
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("success append 完全失败（未提交）仍收口真实错误，不静默", async () => {
  const harness = createTurnHarness();
  harness.control.failEventType = SessionEventType.TurnComplete;
  harness.control.failAfterStore = false;
  const run = executeTurnCommand.call(
    harness.runtime,
    "append fails",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  await assert.rejects(run);
  assert.equal(countTurnComplete(harness.appended, "success"), 0);
  // 未提交时必须保留真实错误终态（TurnError 或 cancelled），不能无终态。
  assert.equal(
    harness.appended.some(
      (event) =>
        event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError,
    ),
    true,
  );
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("preventContinuation: Stop 在 hook await 中到达，只 cancelled 不落 success", async () => {
  const harness = createTurnHarness();
  harness.control.preventContinuation = true;
  harness.control.userPromptHooks = deferred();
  harness.control.userPromptHooksStarted = deferred();
  const run = executeTurnCommand.call(
    harness.runtime,
    "blocked by hook",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  await harness.control.userPromptHooksStarted.promise;
  const stopped = stop(harness);
  assert.equal(stopped.kind, "stopped");
  harness.control.userPromptHooks.resolve();
  await assert.rejects(run);

  assert.equal(countTurnComplete(harness.appended, "success"), 0);
  assert.equal(countTurnComplete(harness.appended, "cancelled"), 1);
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("success 提交后 parent signal abort：不产生第二终态", async () => {
  const harness = createTurnHarness();
  harness.control.projection = deferred();
  const run = executeTurnCommand.call(
    harness.runtime,
    "commit then parent abort",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(countTurnComplete(harness.appended, "success"), 1);
  // 成功事件已经提交；此时直接 abort parent signal（不是 runtime Stop）也不能改写终态。
  harness.execution.controller.abort(new Error("late parent abort"));
  harness.control.projection.resolve();
  await run;

  assert.equal(countTurnComplete(harness.appended, "success"), 1);
  assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
  assert.equal(
    harness.appended.some((event) => event.type === SessionEventType.TurnError),
    false,
  );
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("success 提交后 postwork 真失败：保留原错误且不追加矛盾终态", async () => {
  const harness = createTurnHarness();
  harness.control.projection = deferred();
  harness.control.projectionError = new Error("postwork exploded");
  const run = executeTurnCommand.call(
    harness.runtime,
    "commit then postwork fails",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(countTurnComplete(harness.appended, "success"), 1);
  harness.execution.controller.abort(new Error("late parent abort"));
  harness.control.projection.resolve();
  const error = await run.then(
    () => {
      throw new Error("expected postwork failure");
    },
    (caught: unknown) => caught,
  );

  // 已提交后真实故障仍保留 error cause；晚到 abort 不能把它改写成 cancelled。
  const cause = (error as Error).cause;
  assert.equal(cause instanceof Error ? cause.message : "", "postwork exploded");
  assert.equal(countTurnComplete(harness.appended, "success"), 1);
  assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
  assert.equal(
    harness.appended.some((event) => event.type === SessionEventType.TurnError),
    false,
  );
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("真实 events.ts appendEvent 在 notify 阶段失败：SESSION_EVENT_STORED_ERROR 阻止第二终态", async () => {
  const harness = createTurnHarness();
  harness.control.realTurnCompleteAppend = true;
  harness.control.failNotifySinks = true;
  // eventStore 回查也失败，确保 committed 判定只能来自 appendEvent 打上的标记。
  harness.control.failEventRead = true;
  const run = executeTurnCommand.call(
    harness.runtime,
    "notify sink fails after store",
    undefined,
    { abortSignal: harness.execution.controller.signal, traceContext: TRACE, inputId: "input-1" },
    makeReservation(),
  );

  const error = await run.then(
    () => {
      throw new Error("expected notify sink failure");
    },
    (caught: unknown) => caught,
  );
  assert.equal(
    isSessionEventStoredError((error as Error).cause),
    true,
    "notify 阶段失败必须携带 SESSION_EVENT_STORED_ERROR",
  );
  // eventStore 已接受 success；notify 阶段拒绝只能视为部分提交，不能再写 cancelled。
  assert.equal(countTurnComplete(harness.stored, "success"), 1);
  assert.equal(countTurnComplete(harness.appended, "success"), 0);
  assert.equal(countTurnComplete(harness.appended, "cancelled"), 0);
  assert.equal(
    harness.appended.some((event) => event.type === SessionEventType.TurnError),
    false,
  );
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

interface VerifierHarness {
  appended: SessionEvent[];
  control: GateControl;
  execution: ActiveForegroundExecutionState;
  paused: number;
  runtime: AgentRuntimeInternal;
  stored: SessionEvent[];
  target: SessionGoal;
  targetChanges: number;
  targetUpdates: Array<{ sessionID: string; status: string }>;
}

interface VerifierOptions {
  error?: Error;
  verificationText?: string;
}

function createActiveTarget(): SessionGoal {
  return {
    sessionID: SESSION_ID,
    targetID: "target-1",
    objective: "finish the goal",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 1000, updated: 1000 },
  };
}

function verificationStatuses(events: readonly SessionEvent[]): string[] {
  return events
    .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
    .map((event) => String((event.payload as { status?: string }).status));
}

function createVerifierHarness(options: VerifierOptions = {}): VerifierHarness {
  const appended: SessionEvent[] = [];
  const stored: SessionEvent[] = [];
  const control: GateControl = {};
  const execution = createExecution();
  const target = createActiveTarget();
  const targetUpdates: Array<{ sessionID: string; status: string }> = [];
  let paused = 0;
  let targetChanges = 0;
  let eventSequence = 0;

  const telemetryScope = () => ({
    finishCancelled: () => {},
    finishCompleted: () => {},
    finishFailed: () => {},
    run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    setResultType: () => {},
  });

  const runtime = {
    sessionId: SESSION_ID,
    config: { taskType: "agent" },
    activeForegroundExecution: execution,
    messageHistory: {
      borrowReadOnlyRuntimeEntries: () => [],
    },
    agentTelemetry: {
      detached: telemetryScope,
    },
    createEvent: (
      type: SessionEventType,
      payload: Record<string, unknown>,
      traceContext: TraceContext,
    ) => {
      eventSequence += 1;
      return {
        id: `verifier_event_${eventSequence}`,
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
      if (event.type === SessionEventType.ModelComplete) {
        control.modelCompleteAppendStarted?.resolve();
        await control.modelCompleteAppend?.promise;
      }
      if (event.type === SessionEventType.TargetCompletionVerification) {
        const status = (event.payload as { status?: string }).status;
        if (status === "completed") {
          control.verificationAppendStarted?.resolve();
          await control.verificationAppend?.promise;
          if (control.failCompletedVerification) {
            throw new Error("completed verification append failed");
          }
        }
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
      messages: async () => [],
      saveMessage: async () => {},
      updateTargetStatus: async (input: { sessionID: string; status: string }) => {
        targetUpdates.push(input);
        control.targetPersistenceStarted?.resolve();
        await control.targetPersistence?.promise;
        return { ...target, status: input.status } as SessionGoal;
      },
      // 提供完整 UsageStore 形状，让 recordModelUsageFact 真正走到可阻塞的 await。
      recordModelUsage: async () => {
        control.modelUsageStarted?.resolve();
        await control.modelUsage?.promise;
      },
      pruneUsage: async () => {},
      upsertToolUsage: async () => {},
      upsertTurnUsage: async () => {},
    },
    getSessionModelSelection: () => ({ modelId: "test-model", providerId: "test-provider" }),
    modelFactory: () => ({
      providerId: "test-provider",
      modelId: "test-model",
      displayName: "test-model",
      properties: { contextWindow: 200_000, inputFormat: "text" },
      optionSpecs: { maxOutputTokens: { max: 64_000 } },
      options: {},
      bind() {
        return this;
      },
      generateText: async () => {
        control.generateStarted?.resolve();
        await control.generateGate?.promise;
        if (options.error) {
          throw options.error;
        }
        return {
          text: options.verificationText ?? '{"passed":false,"reason":"not yet"}',
          usage: {},
          finishReason: "stop",
        };
      },
      streamText: () => {
        throw new Error("not used");
      },
    }),
    rebuildProjection: async () => ({
      pendingSteerInputs: [],
      targetCompletionVerificationTimeline: [],
    }),
    extractToolCallsFromResult: () => [],
    createModelStatusSink: () => ({ publish: async () => {} }),
    readSessionTargetForContext: async () => target,
    recordTargetChanged: async () => {
      targetChanges += 1;
    },
    pauseActiveTargetForCancellation: async () => {
      paused += 1;
    },
  } as unknown as AgentRuntimeInternal;

  return {
    appended,
    control,
    execution,
    get paused() {
      return paused;
    },
    runtime,
    stored,
    target,
    get targetChanges() {
      return targetChanges;
    },
    targetUpdates,
  };
}

function runVerifier(harness: VerifierHarness) {
  return verifyActiveTargetCompletionForContinuation.call(harness.runtime, {
    abortSignal: harness.execution.controller.signal,
    target: harness.target,
    traceContext: TRACE,
  });
}

test("verifier: Stop 落在 ModelComplete await，completed 结论不落库", async () => {
  const harness = createVerifierHarness({
    verificationText: '{"passed":true,"reason":"done"}',
  });
  harness.control.modelCompleteAppend = deferred();
  harness.control.modelCompleteAppendStarted = deferred();
  const run = runVerifier(harness);

  await harness.control.modelCompleteAppendStarted.promise;
  const stopped = stop(harness);
  assert.equal(stopped.kind, "stopped");
  harness.control.modelCompleteAppend.resolve();
  await assert.rejects(run);

  assert.deepEqual(verificationStatuses(harness.appended), ["started", "cancelled"]);
  assert.equal(harness.paused, 1);
  assert.equal(harness.targetUpdates.length, 0);
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("verifier: Stop 落在 usage await，completed 结论不落库", async () => {
  const harness = createVerifierHarness({
    verificationText: '{"passed":true,"reason":"done"}',
  });
  harness.control.modelUsage = deferred();
  harness.control.modelUsageStarted = deferred();
  const run = runVerifier(harness);

  await harness.control.modelUsageStarted.promise;
  const stopped = stop(harness);
  assert.equal(stopped.kind, "stopped");
  harness.control.modelUsage.resolve();
  await assert.rejects(run);

  assert.deepEqual(verificationStatuses(harness.appended), ["started", "cancelled"]);
  assert.equal(harness.paused, 1);
  assert.equal(harness.targetUpdates.length, 0);
});

test("verifier: completed 已准入后 Stop 返回 completed，锁覆盖 target 持久化", async () => {
  const harness = createVerifierHarness({
    verificationText: '{"passed":true,"reason":"done"}',
  });
  harness.control.targetPersistence = deferred();
  harness.control.targetPersistenceStarted = deferred();
  const run = runVerifier(harness);

  await harness.control.targetPersistenceStarted.promise;
  assert.equal(harness.execution.successTerminalAdmitted, true);
  const stopped = stop(harness);
  assert.deepEqual(stopped, {
    kind: "completed",
    foregroundExecutionId: harness.execution.foregroundExecutionId,
  });
  assert.equal(harness.execution.controller.signal.aborted, false);
  harness.control.targetPersistence.resolve();
  const result = await run;
  assert.ok(result);

  assert.equal(result.verification.passed, true);
  assert.equal(result.target.status, "complete");
  assert.deepEqual(verificationStatuses(harness.appended), ["started", "completed"]);
  assert.equal(harness.targetUpdates.length, 1);
  assert.equal(harness.targetChanges, 1);
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("verifier: notSatisfied completed 后立即释放锁，nextAction continuation 可停", async () => {
  const harness = createVerifierHarness({
    verificationText: '{"passed":false,"reason":"missing","nextAction":"keep going"}',
  });
  const result = await runVerifier(harness);
  assert.ok(result);

  assert.equal(result.verification.passed, false);
  assert.deepEqual(verificationStatuses(harness.appended), ["started", "completed"]);
  assert.equal(harness.execution.successTerminalAdmitted, false);
  assert.equal(harness.targetUpdates.length, 0);

  const stopped = stop(harness);
  assert.equal(stopped.kind, "stopped");
  assert.equal(harness.execution.controller.signal.aborted, true);
});

test("verifier: 准入前已接受 Stop + 模型普通 Error 仍必须 cancelled", async () => {
  const harness = createVerifierHarness({ error: new Error("model exploded") });
  harness.control.generateStarted = deferred();
  harness.control.generateGate = deferred();
  const run = runVerifier(harness);

  await harness.control.generateStarted.promise;
  const stopped = stop(harness);
  assert.equal(stopped.kind, "stopped");
  harness.control.generateGate.resolve();
  await assert.rejects(run);

  // Stop 已被 foreground controller 接受，模型随后抛普通 Error 不能降级成
  // failed_closed/fail-open；否则已停止的 goal 会被误判为完成。
  assert.deepEqual(verificationStatuses(harness.appended), ["started", "cancelled"]);
  assert.equal(harness.paused, 1);
  assert.equal(harness.targetUpdates.length, 0);
  assert.equal(harness.execution.successTerminalAdmitted, false);
});

test("verifier: 准入后未提交的真实错误 + 晚到 parent abort 仍走 failed_closed", async () => {
  const harness = createVerifierHarness({
    verificationText: '{"passed":true,"reason":"done"}',
  });
  harness.control.verificationAppend = deferred();
  harness.control.verificationAppendStarted = deferred();
  harness.control.failCompletedVerification = true;
  const run = runVerifier(harness);

  await harness.control.verificationAppendStarted.promise;
  // 此时 completed 结论已经准入，但 append 还没成功。
  assert.equal(harness.execution.successTerminalAdmitted, true);
  harness.execution.controller.abort(new Error("late parent abort"));
  harness.control.verificationAppend.resolve();
  const result = await run;
  assert.ok(result);

  // 准入后才到达的 abort 不能把真实 append 故障伪装成 cancelled。
  assert.deepEqual(verificationStatuses(harness.appended), ["started", "failed_closed"]);
  assert.equal(harness.paused, 0);
  assert.equal(result.verification.passed, true);
  assert.equal(harness.targetUpdates.length, 1);
});

test("verifier: 准入前 external fault 优先级高于已接受的 abort", async () => {
  const harness = createVerifierHarness({ error: new Error("provider exploded") });
  harness.control.generateStarted = deferred();
  harness.control.generateGate = deferred();
  const run = runVerifier(harness);

  await harness.control.generateStarted.promise;
  // 宿主外部故障与用户 Stop 共用 AbortSignal，但 external marker 必须优先，
  // 不能把真实故障记成 cancelled（那会暂停 goal 并吞掉错误）。
  harness.execution.controller.abort(
    createExternalTurnFaultError("external_turn_fault", "host fault"),
  );
  harness.control.generateGate.resolve();
  const result = await run;
  assert.ok(result);

  assert.deepEqual(verificationStatuses(harness.appended), ["started", "failed_closed"]);
  assert.equal(harness.paused, 0);
  assert.equal(result.verification.passed, true);
  assert.equal(harness.targetUpdates.length, 1);
});
