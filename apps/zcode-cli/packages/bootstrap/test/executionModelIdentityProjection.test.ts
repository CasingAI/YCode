import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type {
  ExecutionModelIdentity,
  TurnHeaderRow,
  TurnWorkSegment,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// docs/specs/conversation-turn-info.md：工作段的实际执行模型只来自 Runtime 模型步骤
// 开始时发布的 ModelRequest；UI 不按当前选型/admission/marker 推断。

const T0 = 1_700_000_000_000;
const SESSION_ID = "session-execution-models";
const TURN_ID = "turn-execution-models";

let sequenceNumber = 0;
function event(
  type: SessionEventType,
  payload: unknown,
  offsetMs: number,
  turnId: string = TURN_ID,
): SessionEvent {
  sequenceNumber += 1;
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId,
    type,
    timestamp: new Date(T0 + offsetMs),
    traceId: "trace-execution-models",
    sequenceNumber,
    payload,
  } as unknown as SessionEvent;
}

function applyAll(projection: ProductProjection, events: SessionEvent[]): void {
  for (const item of events) projection.applyEvent(item);
}

function startTurn(offsetMs = 0, turnId: string = TURN_ID): SessionEvent {
  return event(
    SessionEventType.TurnStarted,
    { turnNumber: 1, input: "做点事", executionKind: "agent" },
    offsetMs,
    turnId,
  );
}

function modelRequest(
  providerId: string,
  modelId: string,
  offsetMs: number,
  querySource?: string,
  turnId: string = TURN_ID,
): SessionEvent {
  return event(
    SessionEventType.ModelRequest,
    {
      messages: [],
      providerId,
      modelId,
      ...(querySource !== undefined ? { querySource } : {}),
    },
    offsetMs,
    turnId,
  );
}

function guideSteerDrained(offsetMs: number, messageId: string): SessionEvent {
  return event(
    SessionEventType.TurnSteerDrained,
    {
      pendingInputIds: [`pending-${messageId}`],
      targetTurnId: TURN_ID,
      injectedMessageIds: [messageId],
      drainedInputs: [
        {
          pendingInputId: `pending-${messageId}`,
          messageId,
          text: "换个方向",
          delivery: "guide",
        },
      ],
    },
    offsetMs,
  );
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

test("live ModelRequest 把实际 provider/model 写入当前工作段", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("cliproxy-codex", "gpt-6-luna", 1_000, "main_turn"),
  ]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "cliproxy-codex", modelId: "gpt-6-luna" },
  ]);
});

test("当前选型与 admission 不回填实际执行模型", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    event(
      SessionEventType.ModelSelected,
      {
        modelSelection: { providerId: "commandcode", modelId: "deepseek/deepseek-v4.1-flash" },
        previousModelSelection: null,
      },
      500,
    ),
    modelRequest("cliproxy-codex", "gpt-6-luna", 1_000, "main_turn"),
  ]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "cliproxy-codex", modelId: "gpt-6-luna" },
  ]);
});

test("同一模型步骤重复投递只保留一项", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("cliproxy-codex", "gpt-6-luna", 1_000, "main_turn"),
    modelRequest("cliproxy-codex", "gpt-6-luna", 2_000, "main_turn"),
    modelRequest("cliproxy-codex", "gpt-6-luna", 3_000, "main_turn"),
  ]);

  assert.equal(modelsOf(segmentsOf(projection)[0])?.length, 1);
});

test("多个模型按首次发起顺序保留，重复 pair 不重复", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("provider-a", "model-a", 1_000),
    modelRequest("provider-b", "model-b", 2_000),
    modelRequest("provider-a", "model-a", 3_000),
    modelRequest("provider-c", "model-c", 4_000),
  ]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "model-a" },
    { providerId: "provider-b", modelId: "model-b" },
    { providerId: "provider-c", modelId: "model-c" },
  ]);
});

test("同一 modelId 来自不同 provider 时保留两项", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("provider-a", "shared-model", 1_000),
    modelRequest("provider-b", "shared-model", 2_000),
  ]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "shared-model" },
    { providerId: "provider-b", modelId: "shared-model" },
  ]);
});

test("subagent querySource 也属于当前会话自己的模型步骤", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [startTurn(), modelRequest("provider-a", "model-a", 1_000, "subagent")]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "model-a" },
  ]);
});

test("旧事件缺 querySource 时按既有步骤口径记录，不伪造来源", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [startTurn(), modelRequest("provider-a", "model-a", 1_000)]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "model-a" },
  ]);
});

test("compact、标题生成、goal 验证等 sidecar 不进入工作段", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("compact-provider", "compact-model", 1_000, "compact"),
    modelRequest("title-provider", "title-model", 2_000, "session_title"),
    modelRequest("goal-provider", "goal-model", 3_000, "goal_summary_title"),
    modelRequest("verify-provider", "verify-model", 4_000, "target_completion_verification"),
    modelRequest("main-provider", "main-model", 5_000, "main_turn"),
  ]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "main-provider", modelId: "main-model" },
  ]);
});

test("provider/model 缺失或为空时不产生已知身份", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("", "model-a", 1_000),
    modelRequest("provider-a", "", 2_000),
    event(SessionEventType.ModelRequest, { messages: [], modelId: "model-b" }, 3_000),
  ]);

  assert.equal(modelsOf(segmentsOf(projection)[0]), undefined);
});

test("guide 新建工作段：前后模型分别归属各自段", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("provider-a", "model-a", 1_000),
    guideSteerDrained(5_000, "message-guide-1"),
    modelRequest("provider-b", "model-b", 6_000),
  ]);

  const segments = segmentsOf(projection);
  assert.equal(segments.length, 2);
  assert.deepEqual(modelsOf(segments[0]), [{ providerId: "provider-a", modelId: "model-a" }]);
  assert.deepEqual(modelsOf(segments[1]), [{ providerId: "provider-b", modelId: "model-b" }]);
});

test("guide 之后迟到的旧 request 按发起时间回到旧段，不重新归属", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [startTurn(), guideSteerDrained(5_000, "message-guide-1")]);

  // 事件时间戳来自实际模型步骤开始时刻（早于 guide），只是投递晚到。
  applyAll(projection, [modelRequest("provider-old", "model-old", 2_000)]);

  const segments = segmentsOf(projection);
  assert.deepEqual(modelsOf(segments[0]), [{ providerId: "provider-old", modelId: "model-old" }]);
  assert.equal(modelsOf(segments[1]), undefined);
});

test("其他 runtime turn 的迟到 request 不污染当前工作段", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("provider-current", "model-current", 1_000),
    modelRequest("provider-stale", "model-stale", 2_000, "main_turn", "turn-other"),
  ]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-current", modelId: "model-current" },
  ]);
});

test("其他 session 的迟到 request 不污染当前工作段", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  const foreign = modelRequest("provider-foreign", "model-foreign", 2_000);
  const foreignEvent = { ...foreign, sessionId: "session-other" } as SessionEvent;
  applyAll(projection, [
    startTurn(),
    modelRequest("provider-current", "model-current", 1_000),
    foreignEvent,
  ]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-current", modelId: "model-current" },
  ]);
});

test("turn 收口后迟到的 request 不复活工作段模型", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("provider-a", "model-a", 1_000),
    event(
      SessionEventType.TurnComplete,
      { response: "done", tokenCount: 0, toolCallCount: 0, duration: 2_000, resultType: "success" },
      2_000,
    ),
    modelRequest("provider-late", "model-late", 3_000),
  ]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-a", modelId: "model-a" },
  ]);
});

test("工具-only 步骤同样记录执行模型", () => {
  const projection = new ProductProjection(SESSION_ID, "epoch-1");
  applyAll(projection, [
    startTurn(),
    modelRequest("provider-tools", "model-tools", 1_000),
    event(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "call-1",
        assistantMessageId: "assistant-1",
        toolName: "Read",
        input: {},
        schedule: { parallelGroups: [["call-1"]], executionOrder: ["call-1"] },
      },
      2_000,
    ),
  ]);

  assert.deepEqual(modelsOf(segmentsOf(projection)[0]), [
    { providerId: "provider-tools", modelId: "model-tools" },
  ]);
});
