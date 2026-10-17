import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageId,
  MessageWithParts,
  SessionId,
  SessionStorePort,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { resumeFailedTurnCommand } from "../src/runtime/methods/turn-resume.js";

const SESSION_ID = "session-persistence-error" as SessionId;
const USER_MESSAGE_ID = "msg_persistence_error_user" as MessageId;
const TURN_ID = "turn_persistence_error" as TurnId;
const TRACE: TraceContext = { traceId: "trace-persistence-error" as TraceContext["traceId"] };

function failedTranscript(): MessageWithParts[] {
  return [
    {
      info: {
        id: USER_MESSAGE_ID,
        sessionID: SESSION_ID,
        role: "user",
        time: { created: 1_000 },
      },
      parts: [{ id: "part-user", messageID: USER_MESSAGE_ID, sessionID: SESSION_ID, type: "text", text: "retry" }],
    } as unknown as MessageWithParts,
    {
      info: {
        id: "msg_previous_failure" as MessageId,
        sessionID: SESSION_ID,
        role: "assistant",
        parentID: USER_MESSAGE_ID,
        anchor: { turnId: TURN_ID },
        time: { created: 1_100, completed: 1_200 },
        error: { name: "ProviderError", data: { message: "previous failure" } },
      },
      parts: [],
    } as unknown as MessageWithParts,
  ];
}

test("错误消息持久化失败时仍抛出原始模型错误", async () => {
  const providerError = new Error("provider rate limit");
  const persistenceError = new Error("stale execution fence");
  let warningCount = 0;
  let assistantPersistenceCalls = 0;
  const runtime = {
    sessionId: SESSION_ID,
    turnNumber: 1,
    branchGeneration: 1,
    rootTraceContext: TRACE,
    sessionStore: {
      messages: async () => failedTranscript(),
    } as unknown as SessionStorePort,
    messageHistory: {
      borrowReadOnlyRuntimeEntries: () => [
        {
          id: "entry-user",
          message: { role: "user", content: "original prompt" },
          metadata: {},
        },
      ],
      addEntries: () => {},
      setCacheHit: () => {},
    },
    config: { taskType: "agent" },
    getSessionModelSelection: () => ({ providerId: "provider", modelId: "model" }),
    modelFactory: () => ({
      providerId: "provider",
      modelId: "model",
      displayName: "model",
      properties: { contextWindow: 32_000 },
      optionSpecs: { maxOutputTokens: { max: 4_000 } },
      options: {},
      bind() {
        return this;
      },
    }),
    ensureContextInitialized: async () => {},
    applySubmissionExecutionState: async () => undefined,
    logModelRequestSteeringContext: () => {},
    hasInlineGuidePendingInput: () => false,
    runStopHooks: async () => undefined,
    shouldContinueAfterStopHooks: () => false,
    fallbackPendingGuidesToQueue: async () => {},
    injectHookAdditionalContextIntoMessageHistory: () => undefined,
    takeInlineGuidePendingInput: () => undefined,
    currentTurnFileChanges: new Map(),
    extractToolCallsFromResult: () => [],
    reactiveCompactAfterContextExceeded: async () => false,
    persistAssistantMessage: async () => {
      assistantPersistenceCalls += 1;
      if (assistantPersistenceCalls > 1) throw persistenceError;
      return {};
    },
    persistPart: async () => {},
    runModelTextRequest: async () => {
      throw providerError;
    },
    agentTelemetry: {
      step: () => ({
        run: async (fn: () => Promise<unknown>) => fn(),
        finishCompleted: () => {},
        finishCancelled: () => {},
        finishFailed: () => {},
      }),
    },
    microcompactIfNeeded: async () => false,
    autoCompactIfNeeded: async () => false,
    readSessionTodosForContext: async () => "",
    drainPendingRuntimeCommandsForActiveLoop: async () => [],
    getMode: () => "yolo",
    getTools: () => [],
    initializeMcp: async () => {},
    beginActiveTurn: () => ({}),
    finishActiveTurn: () => {},
    createEvent: (type: string, payload: Record<string, unknown>) => ({
      type,
      payload,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      timestamp: new Date(),
      sequenceNumber: 1,
    }),
    appendEvent: async () => {},
    rebuildProjection: async () => {},
    appendTurnOutcomeEvent: async () => {},
    recordModelUsage: async () => {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        if (message === "Failed to persist model execution error") warningCount += 1;
      },
      error: () => {},
    },
  } as unknown as AgentRuntimeInternal;

  await assert.rejects(
    resumeFailedTurnCommand.call(
      runtime,
      USER_MESSAGE_ID,
      undefined,
      TRACE,
      new AbortController().signal,
      { promise: Promise.resolve(), resolve: () => {} } as never,
    ),
    (error: unknown) =>
      error instanceof Error &&
      (error === providerError || ("cause" in error && error.cause === providerError)),
  );
  assert.equal(assistantPersistenceCalls, 2);
  assert.equal(warningCount, 1);
});
