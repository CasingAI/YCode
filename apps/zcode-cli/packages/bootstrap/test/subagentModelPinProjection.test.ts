import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection, SessionEvent } from "@zcode/contracts";
import type { TimelineMarkerRow } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";
import {
  MODEL_SELECTED_EVENT,
  TURN_STARTED_EVENT,
  createPinnedGroup,
  createPinningHarness,
  createSelection,
  type PinningHarness,
} from "../../core/test/helpers/subagent-session-model-pinning-fixtures.js";

const GROUP_ID = "projection-pinned-group";
const SELECTED_A = createSelection("demo", "model-a", "low");
const SELECTED_B = createSelection("demo", "model-b", "high");
const PARENT_MODEL = createSelection("demo", "parent-model", "low");

type ModelChangeMarker = Pick<
  TimelineMarkerRow["marker"],
  "type" | "fromProvider" | "fromModel" | "toProvider" | "toModel"
>;

function visibleModelChanges(projection: ProductProjection): ModelChangeMarker[] {
  return projection
    .getSnapshot()
    .rows.window.filter(
      (row): row is TimelineMarkerRow =>
        row.kind === "timelineMarker" && row.marker.type === "modelChange",
    )
    .map((row) => ({
      type: row.marker.type,
      ...(row.marker.fromProvider ? { fromProvider: row.marker.fromProvider } : {}),
      ...(row.marker.fromModel ? { fromModel: row.marker.fromModel } : {}),
      toProvider: row.marker.toProvider,
      toModel: row.marker.toModel,
    }));
}

function modelConfig(projection: ProductProjection) {
  const config = projection.getSnapshot().config;
  return {
    provider: config.provider,
    model: config.model,
    reasoningLevel: config.thought,
  };
}

function expectedConfig(selection: ModelSelection) {
  return {
    provider: selection.providerId,
    model: selection.modelId,
    reasoningLevel: selection.options?.reasoningLevel ?? "",
  };
}

function childTurnEvents(harness: PinningHarness, childSessionId: string): SessionEvent[] {
  return harness
    .events(childSessionId)
    .filter((event) => event.type === MODEL_SELECTED_EVENT || event.type === TURN_STARTED_EVENT);
}

function reduceLive(events: readonly SessionEvent[]): ProductProjection {
  const first = events[0];
  assert.ok(first, "expected child turn events");
  const projection = new ProductProjection(String(first.sessionId), "pin-live");
  for (const event of events) projection.applyEvent(event);
  return projection;
}

/** 只折进前 `turnCount` 轮（含该轮 TurnStarted），用于比较每一轮的实时显示。 */
function reduceLiveThroughTurn(
  events: readonly SessionEvent[],
  turnCount: number,
): ProductProjection {
  const first = events[0];
  assert.ok(first, "expected child turn events");
  const projection = new ProductProjection(String(first.sessionId), `pin-live-${turnCount}`);
  let seen = 0;
  for (const event of events) {
    projection.applyEvent(event);
    if (event.type !== TURN_STARTED_EVENT) continue;
    seen += 1;
    if (seen === turnCount) return projection;
  }
  assert.fail(`expected ${turnCount} turn_started events, saw ${seen}`);
}

function modelSelectedSelections(
  harness: PinningHarness,
  childSessionId: string,
): ModelSelection[] {
  return harness
    .events(childSessionId)
    .filter((event) => event.type === MODEL_SELECTED_EVENT)
    .map((event) => (event.payload as { modelSelection: ModelSelection }).modelSelection);
}

function expectedModelCall(selection: ModelSelection) {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    reasoningLevel: selection.options?.reasoningLevel,
  };
}

function expectedModelChange(from: ModelSelection | null, to: ModelSelection): ModelChangeMarker {
  return {
    type: "modelChange",
    ...(from ? { fromProvider: from.providerId, fromModel: from.modelId } : {}),
    toProvider: to.providerId,
    toModel: to.modelId,
  };
}

/** 执行 override 不得改动 child 的持久选型与组种子。 */
function assertDurablePin(harness: PinningHarness, childSessionId: string): void {
  assert.deepEqual(
    harness.selection(childSessionId),
    SELECTED_A,
    "execution override 不得改写 child 的 runtime/model_selection",
  );
  const groupState = harness.groupState(childSessionId);
  assert.deepEqual(groupState?.intent, {
    groupId: GROUP_ID,
    groupNameSnapshot: "Pinned group",
  });
  assert.equal(groupState?.pickSeed, childSessionId, "execution override 不得改写组种子");
}

function reduceColdReplay(events: readonly SessionEvent[]): ProductProjection {
  const first = events[0];
  assert.ok(first, "expected persisted child turn events");
  const projection = new ProductProjection(String(first.sessionId), "pin-cold-replay");
  projection.beginHydrationReplay();
  for (const event of events) projection.applyHydrationEvent(event);
  projection.completeHydrationReplay(events.at(-1)?.timestamp.getTime() ?? 0);
  return projection;
}

function assertModelConfig(projection: ProductProjection, selection: ModelSelection): void {
  assert.deepEqual(modelConfig(projection), expectedConfig(selection));
}

function assertRepinMarker(projection: ProductProjection): void {
  assert.ok(
    visibleModelChanges(projection).some(
      (marker) =>
        marker.fromProvider === "demo" &&
        marker.fromModel === "model-a" &&
        marker.toProvider === "demo" &&
        marker.toModel === "model-b",
    ),
    "legal repin must project the actual model-a → model-b transition",
  );
}

function createHarness(): PinningHarness {
  return createPinningHarness({
    profile: {
      name: "projection-pinned-agent",
      description: "Projection pin regression profile",
      source: "user",
      systemPrompt: "Run a deterministic model-selection test.",
      tools: [],
      modelGroupIntent: { groupId: GROUP_ID, groupNameSnapshot: "Pinned group" },
    },
    parentSelection: PARENT_MODEL,
    groups: [
      createPinnedGroup({
        groupId: GROUP_ID,
        name: "Pinned group",
        members: [
          {
            providerId: "demo",
            modelId: "model-a",
            reasoningLevel: "low",
            supportedReasoningLevels: ["low", "high"],
            defaultReasoningLevel: "low",
          },
        ],
      }),
    ],
  });
}

test("child model pin live projection and cold replay agree on first pin, reuse, and legal repin", async () => {
  const harness = createHarness();
  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);
  assert.deepEqual(harness.childModelCalls()[0], {
    providerId: SELECTED_A.providerId,
    modelId: SELECTED_A.modelId,
    reasoningLevel: SELECTED_A.options?.reasoningLevel,
  });

  harness.shared.groups = [
    createPinnedGroup({
      groupId: GROUP_ID,
      name: "Pinned group",
      members: [
        {
          providerId: "demo",
          modelId: "model-b",
          reasoningLevel: "high",
          supportedReasoningLevels: ["low", "high"],
        },
        {
          providerId: "demo",
          modelId: "model-a",
          reasoningLevel: "low",
          selectable: false,
          supportedReasoningLevels: ["low", "high"],
        },
      ],
    }),
  ];
  const continued = await harness.send(String(first.agentId));
  assert.equal(continued.continuation?.status, "completed");
  assert.deepEqual(harness.childModelCalls()[1], {
    providerId: SELECTED_A.providerId,
    modelId: SELECTED_A.modelId,
    reasoningLevel: SELECTED_A.options?.reasoningLevel,
  });

  harness.shared.groups = [
    createPinnedGroup({
      groupId: GROUP_ID,
      name: "Pinned group",
      members: [
        {
          providerId: "demo",
          modelId: "model-b",
          reasoningLevel: "high",
          supportedReasoningLevels: ["low", "high"],
        },
      ],
    }),
  ];
  const repinned = await harness.send(String(first.agentId));
  assert.equal(repinned.continuation?.status, "completed");
  assert.deepEqual(harness.childModelCalls()[2], {
    providerId: SELECTED_B.providerId,
    modelId: SELECTED_B.modelId,
    reasoningLevel: SELECTED_B.options?.reasoningLevel,
  });

  const allTurnEvents = harness.events(childSessionId);
  const modelSelectedIndices = allTurnEvents.flatMap((event, index) =>
    event.type === MODEL_SELECTED_EVENT ? [index] : [],
  );
  const turnStartedIndices = allTurnEvents.flatMap((event, index) =>
    event.type === TURN_STARTED_EVENT ? [index] : [],
  );
  assert.equal(modelSelectedIndices.length, 3);
  assert.equal(turnStartedIndices.length, 3);
  assert.ok(modelSelectedIndices.every((index, turn) => index < turnStartedIndices[turn]!));

  // Live 增量投影：首轮是 source-less marker，沿用 pin 不造横幅，合法重钉落 A → B。
  const liveProjection = reduceLive(childTurnEvents(harness, childSessionId));
  assertModelConfig(liveProjection, SELECTED_B);
  assertRepinMarker(liveProjection);
  const liveMarkers = visibleModelChanges(liveProjection);
  assert.equal(liveMarkers.length, 2);
  assert.deepEqual(liveMarkers[0], {
    type: "modelChange",
    toProvider: "demo",
    toModel: "model-a",
  });
  assert.deepEqual(liveMarkers[1], {
    type: "modelChange",
    fromProvider: "demo",
    fromModel: "model-a",
    toProvider: "demo",
    toModel: "model-b",
  });

  // 冷恢复从 child 持久化 messages 生成 transcript 事件，再走批量 hydration replay；
  // 这验证的是冷恢复真实输入，不是把 live EventStore 事件再 apply 一遍。
  const persistedTranscript = await harness.shared.store.port.messages!({
    sessionID: childSessionId as never,
  });
  const hydratedEvents = synthesizeEventsFromMessages(persistedTranscript, {
    sessionId: childSessionId,
    baseTimestampMs: 1_700_000_000_000,
  }) as SessionEvent[];
  const coldProjection = reduceColdReplay(hydratedEvents);
  assertModelConfig(coldProjection, SELECTED_B);
  assertRepinMarker(coldProjection);
  assert.deepEqual(visibleModelChanges(coldProjection), liveMarkers);
});

/**
 * execution-only override（docs/specs/model-group.md 场景 37）：
 * 执行模型可以是 override，但 durable pin 必须保持 A；实时投影与冷回放都必须
 * 如实展示当轮实际模型（A → O → A），不能出现实时看不到 override 的分叉。
 */
test("execution override resume publishes the actual model in live projection and cold replay while the durable pin stays A", async () => {
  const override = createSelection("demo", "override-model", "high");
  const harness = createHarness();

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);
  assert.deepEqual(harness.childModelCalls()[0], expectedModelCall(SELECTED_A));
  assertDurablePin(harness, childSessionId);

  const afterFirstLive = reduceLiveThroughTurn(childTurnEvents(harness, childSessionId), 1);
  assertModelConfig(afterFirstLive, SELECTED_A);
  assert.deepEqual(visibleModelChanges(afterFirstLive), [expectedModelChange(null, SELECTED_A)]);

  // 第二次执行带 execution-only override：真实请求必须是 override，
  // 但持久选型/组种子仍保持 A/childId。
  const overrideRun = await harness.send(String(first.agentId), undefined, {
    modelOverride: { selection: override, background: "deny" },
  });
  assert.equal(overrideRun.continuation?.status, "completed");
  assert.deepEqual(harness.childModelCalls()[1], expectedModelCall(override));
  assertDurablePin(harness, childSessionId);
  // ModelSelected 是实时投影的唯一模型事实来源；override 轮必须发布实际模型。
  assert.deepEqual(
    modelSelectedSelections(harness, childSessionId).at(-1),
    override,
    "override 轮必须发布实际执行模型的 ModelSelected",
  );
  const afterOverrideLive = reduceLiveThroughTurn(childTurnEvents(harness, childSessionId), 2);
  assertModelConfig(afterOverrideLive, override);
  assert.deepEqual(visibleModelChanges(afterOverrideLive), [
    expectedModelChange(null, SELECTED_A),
    expectedModelChange(SELECTED_A, override),
  ]);

  // 取消 override 回到正常续跑：实际请求回到 A，持久 pin 未被 override 污染。
  const resumed = await harness.send(String(first.agentId));
  assert.equal(resumed.continuation?.status, "completed");
  assert.deepEqual(harness.childModelCalls()[2], expectedModelCall(SELECTED_A));
  assertDurablePin(harness, childSessionId);

  const liveFinal = reduceLiveThroughTurn(childTurnEvents(harness, childSessionId), 3);
  assertModelConfig(liveFinal, SELECTED_A);
  const liveMarkers = visibleModelChanges(liveFinal);
  assert.deepEqual(liveMarkers, [
    expectedModelChange(null, SELECTED_A),
    expectedModelChange(SELECTED_A, override),
    expectedModelChange(override, SELECTED_A),
  ]);

  // 冷恢复走持久 messages → transcript hydration，而不是重放 live EventStore 事件。
  const persistedTranscript = await harness.shared.store.port.messages!({
    sessionID: childSessionId as never,
  });
  const hydratedEvents = synthesizeEventsFromMessages(persistedTranscript, {
    sessionId: childSessionId,
    baseTimestampMs: 1_700_000_000_000,
  }) as SessionEvent[];
  const coldProjection = reduceColdReplay(hydratedEvents);
  assertModelConfig(coldProjection, SELECTED_A);
  assert.deepEqual(
    visibleModelChanges(coldProjection),
    liveMarkers,
    "冷回放必须与实时投影展示相同的实际模型序列",
  );
});

/** 首次 override 不产生永久 pin；下一次正常执行按 child ID 首次钉死 A。 */
test("first execution override does not pin, and the next normal run pins A with matching projections", async () => {
  const override = createSelection("demo", "override-model", "high");
  const harness = createHarness();

  const first = await harness.run(undefined, {
    modelOverride: { selection: override, background: "deny" },
  });
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);
  assert.deepEqual(harness.childModelCalls()[0], expectedModelCall(override));
  assert.equal(harness.selection(childSessionId), undefined, "首次 override 不得写永久选择");
  assert.equal(harness.groupState(childSessionId), undefined, "首次 override 不得钉死组状态");

  const afterOverrideLive = reduceLiveThroughTurn(childTurnEvents(harness, childSessionId), 1);
  assertModelConfig(afterOverrideLive, override);
  assert.deepEqual(visibleModelChanges(afterOverrideLive), [expectedModelChange(null, override)]);

  const pinned = await harness.send(String(first.agentId));
  assert.equal(pinned.continuation?.status, "completed");
  assert.deepEqual(harness.childModelCalls()[1], expectedModelCall(SELECTED_A));
  assertDurablePin(harness, childSessionId);

  const liveFinal = reduceLiveThroughTurn(childTurnEvents(harness, childSessionId), 2);
  assertModelConfig(liveFinal, SELECTED_A);
  const liveMarkers = visibleModelChanges(liveFinal);
  assert.deepEqual(liveMarkers, [
    expectedModelChange(null, override),
    expectedModelChange(override, SELECTED_A),
  ]);

  const persistedTranscript = await harness.shared.store.port.messages!({
    sessionID: childSessionId as never,
  });
  const hydratedEvents = synthesizeEventsFromMessages(persistedTranscript, {
    sessionId: childSessionId,
    baseTimestampMs: 1_700_000_000_000,
  }) as SessionEvent[];
  const coldProjection = reduceColdReplay(hydratedEvents);
  assertModelConfig(coldProjection, SELECTED_A);
  assert.deepEqual(
    visibleModelChanges(coldProjection),
    liveMarkers,
    "首次 override 后的正常钉死也必须冷热一致",
  );
});
