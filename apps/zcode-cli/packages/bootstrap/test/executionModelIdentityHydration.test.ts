import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type MessageWithParts, type SessionEvent } from "@zcode/contracts";
import type {
  ExecutionModelIdentity,
  TurnHeaderRow,
  TurnWorkSegment,
} from "@zcode/shared/zcode-protocol-v4";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

// docs/specs/conversation-turn-info.md：冷恢复只从持久化助手消息的 providerId/modelId
// 合成同类 ModelRequest，再走同一个 ProductProjection reducer；缺字段保持未知，
// 不读用户选型。live 与 cold 的有序模型集合必须一致。

const T0 = 1_700_000_000_000;
const SESSION_ID = "session-execution-models-hydration";

function userMessage(
  id: string,
  createdMs: number,
  options: { guide?: boolean } = {},
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: createdMs },
      ...(options.guide ? { metadata: { turnSteerDelivery: "guide" } } : {}),
    },
    parts: [
      {
        id: `part-${id}`,
        sessionID: SESSION_ID,
        messageID: id,
        type: "text",
        text: options.guide ? "换个方向" : "做点事",
      },
    ],
  } as unknown as MessageWithParts;
}

function assistantMessage(options: {
  id: string;
  createdMs: number;
  providerId?: string;
  modelId?: string;
  parts?: MessageWithParts["parts"];
}): MessageWithParts {
  return {
    info: {
      id: options.id,
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: options.createdMs, completed: options.createdMs + 500 },
      ...(options.providerId ? { providerId: options.providerId } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
    },
    parts:
      options.parts ??
      ([
        {
          id: `part-${options.id}`,
          sessionID: SESSION_ID,
          messageID: options.id,
          type: "text",
          text: "ok",
        },
      ] as MessageWithParts["parts"]),
  } as unknown as MessageWithParts;
}

function synthesize(messages: MessageWithParts[]): SessionEvent[] {
  return synthesizeEventsFromMessages(messages, {
    sessionId: SESSION_ID,
    baseTimestampMs: T0,
  }) as SessionEvent[];
}

function project(events: readonly SessionEvent[]): ProductProjection {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  for (const item of events) projection.applyEvent(item);
  return projection;
}

function headerOf(projection: ProductProjection): TurnHeaderRow | undefined {
  return projection
    .getSnapshot()
    .rows.window.find((row): row is TurnHeaderRow => row.kind === "turnHeader");
}

function segmentsOf(projection: ProductProjection): TurnWorkSegment[] {
  return headerOf(projection)?.workSegments ?? [];
}

function modelsOf(segment: TurnWorkSegment | undefined): ExecutionModelIdentity[] | undefined {
  return segment?.executionModels;
}

test("冷恢复从助手消息执行身份重建模型，按消息顺序并去重", () => {
  const projection = project(
    synthesize([
      userMessage("user-1", T0 + 100),
      assistantMessage({
        id: "assistant-1",
        createdMs: T0 + 1_000,
        providerId: "provider-a",
        modelId: "model-a",
      }),
      assistantMessage({
        id: "assistant-2",
        createdMs: T0 + 2_000,
        providerId: "provider-b",
        modelId: "model-b",
      }),
      assistantMessage({
        id: "assistant-3",
        createdMs: T0 + 3_000,
        providerId: "provider-a",
        modelId: "model-a",
      }),
    ]),
  );

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "model-a" },
    { providerId: "provider-b", modelId: "model-b" },
  ]);
});

test("冷恢复保留同一 modelId 的不同 provider", () => {
  const projection = project(
    synthesize([
      userMessage("user-1", T0 + 100),
      assistantMessage({
        id: "assistant-1",
        createdMs: T0 + 1_000,
        providerId: "provider-a",
        modelId: "shared-model",
      }),
      assistantMessage({
        id: "assistant-2",
        createdMs: T0 + 2_000,
        providerId: "provider-b",
        modelId: "shared-model",
      }),
    ]),
  );

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "shared-model" },
    { providerId: "provider-b", modelId: "shared-model" },
  ]);
});

test("冷恢复缺执行身份时保持未知，不回填用户选型", () => {
  const message = userMessage("user-1", T0 + 100);
  (message.info as unknown as Record<string, unknown>).modelSelection = {
    providerId: "selected-provider",
    modelId: "selected-model",
  };
  const projection = project(
    synthesize([message, assistantMessage({ id: "assistant-old", createdMs: T0 + 1_000 })]),
  );

  assert.equal(modelsOf(segmentsOf(projection)[0]), undefined);
});

test("冷恢复排除旧 compact summary 助手载体，只记录真实模型步骤", () => {
  const compactCarrier = assistantMessage({
    id: "assistant-compact-summary",
    createdMs: T0 + 1_000,
    providerId: "compact-provider",
    modelId: "compact-model",
  });
  (compactCarrier.info as unknown as Record<string, unknown>).summary = true;

  const projection = project(
    synthesize([
      userMessage("user-1", T0 + 100),
      compactCarrier,
      assistantMessage({
        id: "assistant-real",
        createdMs: T0 + 2_000,
        providerId: "provider-a",
        modelId: "model-a",
      }),
    ]),
  );

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "model-a" },
  ]);
});

test("冷恢复对无正文的助手消息仍记录执行身份", () => {
  const projection = project(
    synthesize([
      userMessage("user-1", T0 + 100),
      assistantMessage({
        id: "assistant-empty",
        createdMs: T0 + 1_000,
        providerId: "provider-a",
        modelId: "model-a",
        parts: [],
      }),
    ]),
  );

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "model-a" },
  ]);
});

test("冷恢复按 guide 边界把模型留在各自工作段", () => {
  const projection = project(
    synthesize([
      userMessage("user-1", T0 + 100),
      assistantMessage({
        id: "assistant-before-guide",
        createdMs: T0 + 1_000,
        providerId: "provider-a",
        modelId: "model-a",
      }),
      userMessage("user-guide", T0 + 2_000, { guide: true }),
      assistantMessage({
        id: "assistant-after-guide",
        createdMs: T0 + 3_000,
        providerId: "provider-b",
        modelId: "model-b",
      }),
    ]),
  );

  const segments = segmentsOf(projection);
  assert.equal(segments.length, 2);
  assert.deepEqual(modelsOf(segments[0]), [{ providerId: "provider-a", modelId: "model-a" }]);
  assert.deepEqual(modelsOf(segments[1]), [{ providerId: "provider-b", modelId: "model-b" }]);
});

test("live ModelRequest 与冷恢复合成得到相同的模型集合", () => {
  const messages = [
    userMessage("user-1", T0 + 100),
    assistantMessage({
      id: "assistant-1",
      createdMs: T0 + 1_000,
      providerId: "provider-a",
      modelId: "model-a",
    }),
    userMessage("user-guide", T0 + 2_000, { guide: true }),
    assistantMessage({
      id: "assistant-2",
      createdMs: T0 + 3_000,
      providerId: "provider-b",
      modelId: "model-b",
    }),
  ];
  const cold = project(synthesize(messages));

  let sequenceNumber = 0;
  const liveEvent = (type: SessionEventType, payload: unknown, offsetMs: number): SessionEvent => {
    sequenceNumber += 1;
    return {
      id: `live-${sequenceNumber}`,
      sessionId: SESSION_ID,
      turnId: "turn-live",
      type,
      timestamp: new Date(T0 + offsetMs),
      traceId: "trace-live",
      sequenceNumber,
      payload,
    } as unknown as SessionEvent;
  };
  const live = project([
    liveEvent(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "做点事", executionKind: "agent", messageId: "user-1" },
      100,
    ),
    liveEvent(
      SessionEventType.ModelRequest,
      { messages: [], providerId: "provider-a", modelId: "model-a", querySource: "main_turn" },
      1_000,
    ),
    liveEvent(
      SessionEventType.TurnSteerDrained,
      {
        pendingInputIds: ["pending-guide"],
        targetTurnId: "turn-live",
        injectedMessageIds: ["user-guide"],
        drainedInputs: [
          {
            pendingInputId: "pending-guide",
            messageId: "user-guide",
            text: "换个方向",
            delivery: "guide",
          },
        ],
      },
      2_000,
    ),
    liveEvent(
      SessionEventType.ModelRequest,
      { messages: [], providerId: "provider-b", modelId: "model-b", querySource: "main_turn" },
      3_000,
    ),
    liveEvent(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 0, toolCallCount: 0, duration: 3_000, resultType: "success" },
      4_000,
    ),
  ]);

  assert.deepEqual(
    segmentsOf(live).map((segment) => modelsOf(segment)),
    segmentsOf(cold).map((segment) => modelsOf(segment)),
  );
});

test("cold merge 用 transcript 派生 ModelRequest 去重，不让内存事件重复记入", () => {
  const memoryRequest = (providerId: string, modelId: string): SessionEvent =>
    ({
      id: `memory-${providerId}`,
      sessionId: SESSION_ID,
      turnId: "turn-live",
      type: SessionEventType.ModelRequest,
      timestamp: new Date(T0 + 1_200),
      traceId: "trace-live",
      sequenceNumber: 1,
      payload: { messages: [], providerId, modelId, querySource: "main_turn" },
    }) as unknown as SessionEvent;

  const merged = mergeColdConversationEvents({
    sessionId: SESSION_ID,
    messages: [
      userMessage("user-1", T0 + 100),
      assistantMessage({
        id: "assistant-1",
        createdMs: T0 + 1_000,
        providerId: "provider-a",
        modelId: "model-a",
      }),
    ],
    memoryEvents: [
      memoryRequest("provider-a", "model-a"),
      memoryRequest("provider-live", "model-live"),
    ],
  });

  const modelRequests = merged.events.filter(
    (event) => event.type === SessionEventType.ModelRequest,
  );
  assert.equal(modelRequests.length, 1);
  assert.deepEqual(modelRequests[0]?.payload, {
    messages: [],
    providerId: "provider-a",
    modelId: "model-a",
    querySource: "main_turn",
  });

  const projection = project(merged.events);
  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "model-a" },
  ]);
});
