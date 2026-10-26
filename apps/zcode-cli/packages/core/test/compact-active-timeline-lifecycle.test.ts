import assert from "node:assert/strict";
import test from "node:test";
import { CompactTimelineStatus, CompactTrigger, SessionEventType } from "../src/runtime/deps.js";
import type { Model, SessionEvent, TraceContext } from "../src/runtime/deps.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { compactActiveConversation } from "../src/runtime/methods/compact-active.js";
import {
  buildCompactTimelinePayload,
  finishCompactTimelineFailure,
} from "../src/runtime/methods/compact-persistence.js";

const TRACE_CONTEXT = { traceId: "trace_compact_lifecycle" } as unknown as TraceContext;

const ACTIVE_ENTRIES = [
  { message: { role: "user", content: "first question" } },
  { message: { role: "assistant", content: "first answer" } },
  { message: { role: "user", content: "second question" } },
  { message: { role: "assistant", content: "second answer" } },
] as const;

interface CompactEventPayload {
  operationId: string;
  messageId: string;
  partId?: string;
  attempt?: number;
  maxAttempts?: number;
  replace?: boolean;
  status: string;
}

function createModel(overrides: Partial<Model> = {}): Model {
  return {
    providerId: "test-provider",
    modelId: "test-model",
    options: {},
    properties: {
      inputFormat: "text",
      supportsMidConversationSystem: false,
    },
    optionSpecs: { maxOutputTokens: { max: 8_192 } },
    ...overrides,
  } as unknown as Model;
}

function createHarness(
  input: {
    initializeMcp?: () => Promise<void>;
    getToolsError?: Error;
  } = {},
) {
  const events: SessionEvent[] = [];
  const timelinePayloads: CompactEventPayload[] = [];
  let initializeMcpCalls = 0;
  let getToolsCalls = 0;

  const runtime = {
    config: { modelStreaming: "off" },
    sessionId: "sess_compact_lifecycle",
    logger: undefined,
    latestConversationMessageId: undefined,
    readFileState: new Map(),
    sessionStore: undefined,
    fileSystemPort: undefined,
    agentTelemetry: {
      compaction: () => ({
        finishCancelled: () => {},
        finishCompleted: () => {},
        finishFailed: () => {},
        run: (operation: () => Promise<unknown>) => operation(),
        setInputTokens: () => {},
        setOutputTokens: () => {},
      }),
    },
    messageHistory: {
      borrowReadOnlyRuntimeEntries: () => ACTIVE_ENTRIES,
      replaceMessages: () => {},
    },
    initializeMcp: async () => {
      initializeMcpCalls += 1;
      await input.initializeMcp?.();
    },
    getTools: () => {
      getToolsCalls += 1;
      if (input.getToolsError) throw input.getToolsError;
      return [];
    },
    createModelStatusSink: () => () => {},
    extractToolCallsFromResult: () => [],
    persistCompactSummary: async () => {},
    buildCompactTimelinePayload,
    finishCompactTimelineFailure,
    persistCompactTimeline: async (payload: CompactEventPayload) => {
      timelinePayloads.push(payload);
    },
    createEvent: (type: SessionEventType, payload: unknown, traceContext: TraceContext) =>
      ({
        id: `evt_${events.length + 1}`,
        sessionID: "sess_compact_lifecycle",
        type,
        payload,
        timestamp: new Date(),
        traceContext,
      }) as unknown as SessionEvent,
    appendEvent: async () => {},
  };

  return {
    events,
    getToolsCalls: () => getToolsCalls,
    initializeMcpCalls: () => initializeMcpCalls,
    runtime: runtime as unknown as AgentRuntimeInternal,
    timelinePayloads,
  };
}

function compactEvents(events: readonly SessionEvent[]) {
  return events
    .filter(
      (event) =>
        event.type === SessionEventType.CompactStarted ||
        event.type === SessionEventType.CompactFailed ||
        event.type === SessionEventType.CompactCompleted,
    )
    .map((event) => ({
      type: event.type,
      payload: event.payload as unknown as CompactEventPayload,
    }));
}

function assertPrepFailureTimeline(
  harness: ReturnType<typeof createHarness>,
  expectedStatus: string,
) {
  assert.deepEqual(
    compactEvents(harness.events).map((event) => event.type),
    [SessionEventType.CompactStarted, SessionEventType.CompactFailed],
  );
  const [started, failed] = harness.timelinePayloads;
  assert.deepEqual(
    harness.timelinePayloads.map((payload) => payload.status),
    [CompactTimelineStatus.Started, expectedStatus],
  );
  assert.equal(failed.operationId, started.operationId);
  assert.equal(failed.messageId, started.messageId);
  assert.equal(failed.partId, started.partId);
  assert.equal(failed.replace, true);
  return { started, failed };
}

test("initializeMcp 抛错时用同一 operationId 写 failed，且准备阶段不进入 auto retry", async () => {
  const initializeError = new Error("mcp initialize failed");
  const harness = createHarness({
    initializeMcp: async () => {
      throw initializeError;
    },
  });

  const { events, runtime } = harness;
  await assert.rejects(
    compactActiveConversation.call(runtime, undefined, TRACE_CONTEXT, events, {
      model: createModel(),
      trigger: CompactTrigger.Auto,
    }),
    initializeError,
  );

  const { started, failed } = assertPrepFailureTimeline(harness, CompactTimelineStatus.Failed);
  assert.equal(started.attempt, 1);
  assert.equal(started.maxAttempts, 3);
  assert.equal(failed.attempt, 1);
  assert.equal(harness.initializeMcpCalls(), 1);
  assert.equal(harness.getToolsCalls(), 0);
  assert.equal(
    events.some((event) => event.type === SessionEventType.ModelRequest),
    false,
  );
});

test("初始化期间取消时用同一 operationId 写 interrupted", async () => {
  const controller = new AbortController();
  const harness = createHarness({
    initializeMcp: async () => {
      controller.abort();
    },
  });

  const { events, runtime } = harness;
  await assert.rejects(
    compactActiveConversation.call(runtime, undefined, TRACE_CONTEXT, events, {
      abortSignal: controller.signal,
      model: createModel(),
    }),
  );

  assertPrepFailureTimeline(harness, CompactTimelineStatus.Interrupted);
  assert.equal(harness.getToolsCalls(), 0);
});

test("getTools 抛错时用同一 operationId 写 failed", async () => {
  const toolsError = new Error("tool registry unavailable");
  const harness = createHarness({ getToolsError: toolsError });

  const { events, runtime } = harness;
  await assert.rejects(
    compactActiveConversation.call(runtime, undefined, TRACE_CONTEXT, events, {
      model: createModel(),
    }),
    toolsError,
  );

  assertPrepFailureTimeline(harness, CompactTimelineStatus.Failed);
  assert.equal(harness.initializeMcpCalls(), 1);
  assert.equal(harness.getToolsCalls(), 1);
});

test("成功路径初始化只执行一次并写 completed 终态", async () => {
  const model = createModel({
    streamText: () =>
      (async function* () {
        yield { type: "start" };
        yield { type: "text_start", id: "summary_1" };
        yield { type: "text_delta", id: "summary_1", text: "summary body" };
        yield { type: "text_end", id: "summary_1" };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      })(),
  } as unknown as Partial<Model>);
  const harness = createHarness();

  const { events, runtime } = harness;
  const result = await compactActiveConversation.call(runtime, undefined, TRACE_CONTEXT, events, {
    model,
  });

  assert.equal(result.outcome, "compacted");
  const timeline = compactEvents(events);
  assert.deepEqual(
    timeline.map((event) => event.type),
    [SessionEventType.CompactStarted, SessionEventType.CompactCompleted],
  );
  assert.equal(timeline[0]?.payload.operationId, timeline[1]?.payload.operationId);
  assert.equal(timeline[1]?.payload.status, CompactTimelineStatus.Completed);
  assert.equal(harness.initializeMcpCalls(), 1);
  assert.equal(harness.getToolsCalls(), 1);
});

test("Auto 模型请求重试保持同一 operationId，且初始化只执行一次", async () => {
  const retryableError = new Error("temporary provider failure");
  const model = createModel({
    streamText: () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "start" };
        throw retryableError;
      },
    }),
    generateText: async () => {
      throw retryableError;
    },
  } as unknown as Partial<Model>);
  const harness = createHarness();

  const { events, runtime } = harness;
  await assert.rejects(
    compactActiveConversation.call(runtime, undefined, TRACE_CONTEXT, events, {
      model,
      trigger: CompactTrigger.Auto,
    }),
    retryableError,
  );

  const timeline = compactEvents(events);
  assert.deepEqual(
    timeline.map((event) => event.type),
    [
      SessionEventType.CompactStarted,
      SessionEventType.CompactStarted,
      SessionEventType.CompactStarted,
      SessionEventType.CompactFailed,
    ],
  );
  assert.deepEqual(
    timeline.map((event) => event.payload.status),
    [
      CompactTimelineStatus.Started,
      CompactTimelineStatus.Retrying,
      CompactTimelineStatus.Retrying,
      CompactTimelineStatus.Failed,
    ],
  );
  assert.equal(harness.initializeMcpCalls(), 1);
  const operationIds = new Set(timeline.map((event) => event.payload.operationId));
  assert.equal(operationIds.size, 1);
  assert.equal(harness.timelinePayloads.at(-1)?.status, CompactTimelineStatus.Failed);
});
