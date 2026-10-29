import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_ENTRY_MODEL_GROUP,
  SESSION_ENTRY_MODEL_SELECTION,
  createSessionId,
  type ModelGroupIntent,
  type ModelSelection,
} from "@zcode/contracts";
import type { AgentProfile } from "../src/subagent/profile.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import {
  MODEL_SELECTED_EVENT,
  PINNING_WORKSPACE_IDENTITY,
  PINNING_WORKSPACE_ROOT,
  TURN_STARTED_EVENT,
  createPinnedGroup,
  createPinningHarness,
  createSelection,
  findLastEvent,
  type PinningHarness,
} from "./helpers/subagent-session-model-pinning-fixtures.js";

/**
 * 子智能体模型固定绑定（docs/specs/model-group.md 场景 33-37）真实运行时回归。
 *
 * 每个 case 都通过 `createDefaultSubagentPort` + 真实 `AgentRuntime` 执行：
 * 首次 run、终态 SendMessage 续跑或父 Runtime 重建后的冷恢复。断言同时覆盖
 * child 自己的 entry、ModelSelected/TurnStarted 事件，以及 modelFactory 实际
 * 收到的 provider/model/档位，避免“只写了绑定但请求已换模型”的假绿。
 */

const GROUP_ID = "group-pinned";

function groupIntent(name = "固定组"): ModelGroupIntent {
  return { groupId: GROUP_ID, groupNameSnapshot: name };
}

function pinnedProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "pinned-subagent",
    description: "Pinned session-model regression profile",
    source: "user",
    systemPrompt: "You are a deterministic test subagent.",
    tools: [],
    modelGroupIntent: groupIntent(),
    ...overrides,
  };
}

function memberA() {
  return {
    providerId: "demo",
    modelId: "model-a",
    reasoningLevel: "low",
    supportedReasoningLevels: ["low", "high"],
    defaultReasoningLevel: "low",
  } as const;
}

function memberB() {
  return {
    providerId: "demo",
    modelId: "model-b",
    reasoningLevel: "high",
    supportedReasoningLevels: ["low", "high"],
    defaultReasoningLevel: "high",
  } as const;
}

function memberC() {
  return {
    providerId: "demo",
    modelId: "model-c",
    reasoningLevel: "high",
    supportedReasoningLevels: ["high"],
    defaultReasoningLevel: "high",
  } as const;
}

const SELECTION_A = createSelection("demo", "model-a", "low");
const SELECTION_B = createSelection("demo", "model-b", "high");
const SELECTION_C = createSelection("demo", "model-c", "high");
const PARENT_SELECTION = createSelection("demo", "parent-model", "low");

function assertModelCall(harness: PinningHarness, index: number, expected: ModelSelection): void {
  const call = harness.childModelCalls()[index];
  assert.ok(call, `expected model call #${index}`);
  assert.deepEqual(
    {
      providerId: call.providerId,
      modelId: call.modelId,
      ...(call.reasoningLevel ? { options: { reasoningLevel: call.reasoningLevel } } : {}),
    },
    expected,
  );
}

function lastModelSelected(harness: PinningHarness, childSessionId: string) {
  const found = findLastEvent(harness.events(childSessionId), MODEL_SELECTED_EVENT);
  assert.ok(found, "expected a model_selected event");
  return found;
}

test("首次 run 钉死组选择；候选池变化、重排、旧成员 selectable=false 与跨时段后终态续跑仍用原成员", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  // 首次执行：实际请求、child selection、child group（intent+seed）三者一致。
  assertModelCall(harness, 0, SELECTION_A);
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A);
  const firstGroup = harness.groupState(childSessionId) as
    | { intent?: ModelGroupIntent; pickSeed?: string | null }
    | undefined;
  assert.deepEqual(firstGroup?.intent, groupIntent());
  assert.equal(firstGroup?.pickSeed, childSessionId, "首次钉死种子必须是 child ID");

  const firstSelected = lastModelSelected(harness, childSessionId);
  const firstTurn = findLastEvent(harness.events(childSessionId), TURN_STARTED_EVENT);
  assert.ok(firstTurn);
  assert.ok(firstSelected.index < firstTurn.index, "ModelSelected 必须先于 TurnStarted 落库");

  // 候选池在两次执行之间发生所有“不得改变绑定”的变化：
  // 新增更高优先级成员、重排、原成员 selectable=false、全时段降级。
  harness.shared.groups = [
    createPinnedGroup({
      groupId: GROUP_ID,
      name: "固定组",
      members: [
        {
          ...memberB(),
          deprioritizeSchedule: {
            timeZone: "UTC",
            windows: [
              {
                daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
                startTime: "00:00",
                endTime: "23:59",
              },
            ],
          },
        },
        memberC(),
        { ...memberA(), selectable: false },
      ],
    }),
  ];

  const continued = await harness.send(String(first.agentId));
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "completed");

  assertModelCall(harness, 1, SELECTION_A);
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A);
  const continuedGroup = harness.groupState(childSessionId);
  assert.equal(continuedGroup?.pickSeed, childSessionId, "续跑不得更换抽选种子");
  assert.deepEqual(continuedGroup?.intent, groupIntent());

  const continuedSelected = lastModelSelected(harness, childSessionId);
  const continuedPayload = continuedSelected.event.payload as {
    modelSelection: ModelSelection;
    previousModelSelection?: ModelSelection | null;
  };
  assert.deepEqual(continuedPayload.modelSelection, SELECTION_A);
  assert.deepEqual(
    continuedPayload.previousModelSelection,
    SELECTION_A,
    "沿用同一实际模型时 previous 必须是同一选择（不产生切换）",
  );
  const continuedTurn = findLastEvent(harness.events(childSessionId), TURN_STARTED_EVENT);
  assert.ok(continuedTurn);
  assert.ok(
    continuedSelected.index < continuedTurn.index,
    "续跑的 ModelSelected 必须先于本轮 TurnStarted",
  );
});

test("销毁并重建 Parent Runtime/port 后 cold SendMessage 仍恢复到 child 自己的固定成员", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);
  const agentId = String(first.agentId);

  // 重建前先把候选池改成“如果重新抽选绝不会落回 A”的形态。
  harness.shared.groups = [
    createPinnedGroup({
      groupId: GROUP_ID,
      name: "固定组",
      members: [memberB(), memberC(), { ...memberA(), selectable: false }],
    }),
  ];

  // 新 Parent Runtime 的 live registry 为空，只能通过持久化身份冷恢复 child。
  const rebuilt = harness.rebuildParent();
  assert.notEqual(rebuilt.runtime, harness.runtime);

  const continued = await rebuilt.send(agentId);
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "completed");

  assertModelCall(harness, 1, SELECTION_A);
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A);
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);

  const selected = lastModelSelected(harness, childSessionId);
  const payload = selected.event.payload as { modelSelection: ModelSelection };
  assert.deepEqual(payload.modelSelection, SELECTION_A);
});

test("旧 child 只有稳定选择与 profile 组意图、没有组 entry 时沿用选择并补写组状态（seed=child ID）", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  // 模拟升级前启动的 child：只有具体选择，没有 runtime/model_group。
  harness.shared.store.deleteEntries(childSessionId, SESSION_ENTRY_MODEL_GROUP);
  assert.equal(harness.groupState(childSessionId), undefined);
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A);

  // 组名单改变也不能改变旧 child 已生效的成员。
  harness.shared.groups = [
    createPinnedGroup({
      groupId: GROUP_ID,
      name: "固定组",
      members: [memberB(), memberC(), { ...memberA(), selectable: false }],
    }),
  ];

  const continued = await harness.rebuildParent().send(String(first.agentId));
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "completed");

  assertModelCall(harness, 1, SELECTION_A);
  const restoredGroup = harness.groupState(childSessionId);
  assert.ok(restoredGroup, "旧 child 恢复后必须补写 runtime/model_group");
  assert.deepEqual(restoredGroup.intent, groupIntent());
  assert.equal(restoredGroup.pickSeed, childSessionId);
});

test("原成员离组才重钉：写回新选择、事件 old→new 在 TurnStarted 前、实际请求与落库一致", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
    modelCatalog: [PARENT_SELECTION, SELECTION_A, SELECTION_B, SELECTION_C],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  // 原成员被移出组，组内只剩 B：这是唯一允许改变已启动 child 的条件。
  harness.shared.groups = [
    createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberB()] }),
  ];

  const continued = await harness.send(String(first.agentId));
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "completed");

  assertModelCall(harness, 1, SELECTION_B);
  assert.deepEqual(harness.selection(childSessionId), SELECTION_B, "重钉必须覆盖 child selection");
  assert.equal(
    harness.groupState(childSessionId)?.pickSeed,
    childSessionId,
    "重钉必须沿用 child 首次钉定的抽选种子",
  );

  const selected = lastModelSelected(harness, childSessionId);
  const payload = selected.event.payload as {
    modelSelection: ModelSelection;
    previousModelSelection?: ModelSelection | null;
  };
  assert.deepEqual(payload.modelSelection, SELECTION_B);
  assert.deepEqual(payload.previousModelSelection, SELECTION_A, "事件必须报告旧实际模型");

  const turn = findLastEvent(harness.events(childSessionId), TURN_STARTED_EVENT);
  assert.ok(turn);
  assert.ok(selected.index < turn.index, "重钉的 ModelSelected 先于本轮 TurnStarted");
});

test("首次 run 写 runtime/model_selection 失败时拒绝启动且不发起模型请求", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
    failEntryWrite: (entry) => entry.type === SESSION_ENTRY_MODEL_SELECTION,
  });

  const first = await harness.run();
  assert.equal(first.status, "failed");
  assert.match(String(first.error), /failed to persist child model selection/);
  assert.equal(harness.childModelCalls().length, 0, "首次 selection 未持久化不得调用模型");
  assert.equal(
    harness.entries(String(first.childSessionId), SESSION_ENTRY_MODEL_SELECTION).length,
    0,
  );
});

test("相同 modelId 的不同 provider 保持首次钉定供应商，经历候选池变化、429 与 cold SendMessage", async () => {
  const sharedModelA = createSelection("provider-a", "shared-model", "low");
  const sharedModelB = createSelection("provider-b", "shared-model", "low");
  const providerA = {
    providerId: "provider-a",
    modelId: "shared-model",
    reasoningLevel: "low",
    supportedReasoningLevels: ["low"],
    defaultReasoningLevel: "low",
  } as const;
  const providerB = { ...providerA, providerId: "provider-b" };
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    modelCatalog: [sharedModelA, sharedModelB, PARENT_SELECTION],
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [providerA] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);
  assertModelCall(harness, 0, sharedModelA);
  assert.deepEqual(harness.selection(childSessionId), sharedModelA);

  // 同 modelId 的 provider-b 成为新候选；provider-a 仍在组但 selectable=false。
  harness.shared.groups = [
    createPinnedGroup({
      groupId: GROUP_ID,
      name: "固定组",
      members: [{ ...providerB }, { ...providerA, selectable: false }],
    }),
  ];
  harness.shared.behavior.nextError = new Error("429 Too Many Requests");
  const throttled = await harness.send(String(first.agentId));
  assert.equal(throttled.continuation?.status, "failed");
  assertModelCall(harness, 1, sharedModelA);
  assert.deepEqual(harness.selection(childSessionId), sharedModelA);

  const coldContinuation = await harness.rebuildParent().send(String(first.agentId));
  assert.equal(coldContinuation.continuation?.status, "completed");
  assertModelCall(harness, 2, sharedModelA);
  assert.deepEqual(harness.selection(childSessionId), sharedModelA);
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);

  assert.notDeepEqual(sharedModelA, sharedModelB);
  assert.equal(
    harness.childModelCalls().every((call) => call.providerId === "provider-a"),
    true,
    "模型 ID 相同也必须固定 provider-a，而非漂移到 provider-b",
  );

  // 只有原 pin 成员从组中移除后才允许重钉到同 modelId 的 provider-b。
  harness.shared.groups = [
    createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [{ ...providerB }] }),
  ];
  const repinned = await harness.rebuildParent().send(String(first.agentId));
  assert.equal(repinned.continuation?.status, "completed");
  assertModelCall(harness, 3, sharedModelB);
  assert.deepEqual(harness.selection(childSessionId), sharedModelB);
});

test("组被删除时拒绝启动：保留旧 pin、不回落父模型、不发起模型请求", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  harness.shared.groups = [];
  const continued = await harness.send(String(first.agentId));
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "failed");
  assert.match(String(continued.continuation?.error), /modelGroup\.deleted/);

  assert.equal(harness.childModelCalls().length, 1, "解析失败不得发起模型请求");
  const calls = harness.childModelCalls();
  assert.equal(
    calls.some((call) => call.modelId === "parent-model"),
    false,
    "组不可用不得回落父模型",
  );
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A);
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);
});

test("组内没有可用成员时拒绝启动：保留旧 pin、不发起模型请求", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  harness.shared.groups = [
    createPinnedGroup({
      groupId: GROUP_ID,
      name: "固定组",
      members: [{ providerId: "ghost", modelId: "missing", reasoningLevel: "low" }],
    }),
  ];
  const continued = await harness.send(String(first.agentId));
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "failed");
  assert.match(String(continued.continuation?.error), /modelGroup\.noMembers/);

  assert.equal(harness.childModelCalls().length, 1);
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A);
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);
});

test("429 失败后续跑仍固定原成员；失败不会触发换组或重新抽选", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  harness.shared.behavior.nextError = new Error("429 Too Many Requests");
  const failed = await harness.send(String(first.agentId));
  assert.equal(failed.status, "success");
  assert.equal(failed.continuation?.status, "failed");
  assert.match(String(failed.continuation?.error), /429/);
  assertModelCall(harness, 1, SELECTION_A);
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A);

  // 限流恢复后再次续跑仍然使用原成员与档位。
  const succeeded = await harness.send(String(first.agentId));
  assert.equal(succeeded.status, "success");
  assert.equal(succeeded.continuation?.status, "completed");
  assertModelCall(harness, 2, SELECTION_A);
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);
});

test("父继承的非组 child 在父模型变化后不重新继承", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile({ modelGroupIntent: undefined }),
    parentSelection: PARENT_SELECTION,
    groups: [],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  assertModelCall(harness, 0, PARENT_SELECTION);
  assert.deepEqual(harness.selection(childSessionId), PARENT_SELECTION);
  assert.equal(harness.groupState(childSessionId), undefined);

  // 父 Runtime 的默认模型变化不应修改已启动的非组 child。
  const parentModelTwo = createSelection("demo", "parent-model-2", "high");
  harness.runtime.setSessionModelSelection(parentModelTwo);

  const continued = await harness.send(String(first.agentId));
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "completed");

  assertModelCall(harness, 1, PARENT_SELECTION);
  assert.deepEqual(harness.selection(childSessionId), PARENT_SELECTION);
});

test("读取 child 模型绑定失败时拒绝启动且不发起模型请求", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  harness.shared.store.failEntryRead = (input) => input.type === SESSION_ENTRY_MODEL_SELECTION;
  try {
    const continued = await harness.send(String(first.agentId));
    assert.equal(continued.status, "success");
    assert.equal(continued.continuation?.status, "failed");
    assert.match(
      String(continued.continuation?.error),
      /failed to read child model binding|model-binding-read-failed/,
    );
    assert.equal(harness.childModelCalls().length, 1);
    assert.deepEqual(harness.selection(childSessionId), SELECTION_A);
  } finally {
    harness.shared.store.failEntryRead = undefined;
  }
});

test("重钉时写入 child 选择失败时拒绝启动且不发起模型请求", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  harness.shared.groups = [
    createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberB()] }),
  ];
  harness.shared.store.failEntryWrite = (entry) => entry.type === SESSION_ENTRY_MODEL_SELECTION;
  try {
    const continued = await harness.send(String(first.agentId));
    assert.equal(continued.status, "success");
    assert.equal(continued.continuation?.status, "failed");
    assert.match(
      String(continued.continuation?.error),
      /failed to persist child model selection|model-binding-persist-failed/,
    );
    assert.equal(harness.childModelCalls().length, 1, "持久化失败不得退回临时模型请求");
    assert.deepEqual(harness.selection(childSessionId), SELECTION_A);
  } finally {
    harness.shared.store.failEntryWrite = undefined;
  }
});

test("首次 run 写入组状态失败时拒绝启动且不发起模型请求", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  harness.shared.store.failEntryWrite = (entry) => entry.type === SESSION_ENTRY_MODEL_GROUP;
  try {
    const first = await harness.run();
    assert.equal(first.status, "failed");
    assert.match(String(first.error), /failed to persist child model group state/);
    assert.equal(harness.childModelCalls().length, 0, "组状态未落库不得发起模型请求");
    const childSessionId = String(first.childSessionId);
    assert.equal(harness.groupState(childSessionId), undefined);
  } finally {
    harness.shared.store.failEntryWrite = undefined;
  }
});

test("Fork 拷贝的组种子原样沿用：重钉时使用 Fork 源种子而不是新 child ID", async () => {
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const sourceChildSessionId = String(first.childSessionId);

  // 模拟 Fork：新 child 拥有同一份 selection/group 快照（含源 seed）与独立身份绑定。
  const forkedChildSessionId = createSessionId();
  const forkedAgentId = "agent_forked_pinned";
  const profile = pinnedProfile();
  await harness.shared.store.port.createSubagentChildSession!(
    {
      id: forkedChildSessionId,
      projectID: harness.parentSessionId as never,
      workspaceID: PINNING_WORKSPACE_IDENTITY as never,
      parentID: harness.parentSessionId,
      taskType: "subagent_child",
      slug: "forked-pinned-child",
      directory: PINNING_WORKSPACE_ROOT,
      path: PINNING_WORKSPACE_ROOT,
      title: "forked pinned child",
      version: "0.0.0",
    },
    {
      agentId: forkedAgentId,
      childSessionId: String(forkedChildSessionId),
      agentType: profile.name,
      profile: profile as unknown as Record<string, unknown>,
      workspaceIdentity: PINNING_WORKSPACE_IDENTITY,
      workspaceRoot: PINNING_WORKSPACE_ROOT,
      contextResetGeneration: 0,
    },
  );
  for (const type of [SESSION_ENTRY_MODEL_SELECTION, SESSION_ENTRY_MODEL_GROUP]) {
    const sourceEntries = harness.shared.store.entriesFor(sourceChildSessionId, type);
    assert.equal(sourceEntries.length, 1);
    for (const entry of sourceEntries) {
      await harness.shared.store.port.saveSessionEntry!({
        ...entry,
        id: `${String(forkedChildSessionId)}:${type}`,
        sessionID: forkedChildSessionId,
      });
    }
  }
  assert.equal(
    harness.groupState(String(forkedChildSessionId))?.pickSeed,
    sourceChildSessionId,
    "Fork 拷贝后组种子应保持源 child ID",
  );

  // 源成员离组，触发一次合法重钉：种子必须继续沿用 Fork 源种子。
  harness.shared.groups = [
    createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberB()] }),
  ];

  const continued = await harness.rebuildParent().send(forkedAgentId);
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "completed");

  assertModelCall(harness, 1, SELECTION_B);
  assert.equal(
    harness.groupState(String(forkedChildSessionId))?.pickSeed,
    sourceChildSessionId,
    "Fork 后的重钉不得把种子换成新 child ID",
  );
});

/**
 * execution-only override（docs/specs/model-group.md 场景 37 / 子智能体固定粒度）：
 * 本轮实际请求 override，但 override 不能经首次 session 持久化变成 child 的永久 pin。
 */
test("execution override 首轮只作用于本次执行：不写 child pin；移除 override 后按组与 child ID 正常钉死", async (t) => {
  const override = createSelection("demo", "override-model", "high");
  // 构造期语义：child runtime 自始持有本轮 override（MCS/搜索/上下文预算按它塑形），
  // 持久化边界才把它挡在永久 pin 之外。
  const childConfigSelections: Array<{
    sessionId: string;
    selection: ModelSelection | undefined;
  }> = [];
  const originalEmit = AgentRuntime.prototype.emitModelSelected;
  t.mock.method(
    AgentRuntime.prototype,
    "emitModelSelected",
    async function (
      this: AgentRuntime,
      options: Parameters<AgentRuntime["emitModelSelected"]>[0],
    ): Promise<void> {
      const config = (this as unknown as { config?: { modelSelection?: ModelSelection } }).config;
      childConfigSelections.push({
        sessionId: String(this.sessionId),
        selection: config?.modelSelection,
      });
      return originalEmit.call(this, options);
    },
  );
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run(undefined, {
    modelOverride: { selection: override, background: "deny" },
  });
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  // 实际执行确实是 override（模型请求与首轮 ModelSelected 一致）。
  assertModelCall(harness, 0, override);
  assert.deepEqual(
    childConfigSelections.find((entry) => entry.sessionId === childSessionId)?.selection,
    override,
    "child runtime 构造期的实际选择必须是本轮 override",
  );
  assert.ok(
    harness.shared.factorySelections.some(
      (entry) =>
        entry.providerId === override.providerId &&
        entry.modelId === override.modelId &&
        entry.reasoningLevel === "high",
    ),
    "构造期 model factory 必须收到本轮 override",
  );
  const firstSelected = lastModelSelected(harness, childSessionId);
  assert.deepEqual(
    (firstSelected.event.payload as { modelSelection: ModelSelection }).modelSelection,
    override,
  );
  // 但 override 不得成为 child 的持久绑定或组钉死。
  assert.equal(
    harness.selection(childSessionId),
    undefined,
    "override 不得写入 runtime/model_selection",
  );
  assert.equal(harness.groupState(childSessionId), undefined, "override 首轮不得钉死组状态");

  // 去掉 override 续跑：child 此前没有永久 pin，应按自己的 child ID 首次钉死。
  const continued = await harness.send(String(first.agentId));
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "completed");
  assertModelCall(harness, 1, SELECTION_A);
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A);
  assert.deepEqual(harness.groupState(childSessionId)?.intent, groupIntent());
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);
});

test("既有 child pin 的 override 续跑不改写选择与组种子；再次无 override 续跑仍用原 pin", async (t) => {
  const override = createSelection("demo", "override-model", "high");
  const observedGroupStates: Array<{ sessionId: string; state: unknown }> = [];
  const originalEmit = AgentRuntime.prototype.emitModelSelected;
  t.mock.method(
    AgentRuntime.prototype,
    "emitModelSelected",
    async function (
      this: AgentRuntime,
      options: Parameters<AgentRuntime["emitModelSelected"]>[0],
    ): Promise<void> {
      observedGroupStates.push({
        sessionId: String(this.sessionId),
        state: this.getSessionModelGroupState(),
      });
      return originalEmit.call(this, options);
    },
  );
  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);

  const withOverride = await harness.send(String(first.agentId), undefined, {
    modelOverride: { selection: override, background: "deny" },
  });
  assert.equal(withOverride.status, "success");
  assert.equal(withOverride.continuation?.status, "completed");
  assertModelCall(harness, 1, override);
  assert.deepEqual(
    observedGroupStates.filter((entry) => entry.sessionId === childSessionId).at(-1)?.state,
    harness.groupState(childSessionId),
    "临时覆盖也必须恢复 child runtime 内存中的组状态与原种子",
  );
  assert.ok(
    harness.shared.factorySelections.some(
      (entry) =>
        entry.providerId === override.providerId &&
        entry.modelId === override.modelId &&
        entry.reasoningLevel === "high",
    ),
    "override 续跑的构造期 model factory 也必须收到 override",
  );
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A, "override 不得改写持久选择");
  assert.equal(
    harness.groupState(childSessionId)?.pickSeed,
    childSessionId,
    "override 不得改写组种子",
  );

  // 后续无 override：仍从 child 自己持久化的 pin 续跑，不继承上一轮 override。
  const continued = await harness.send(String(first.agentId));
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "completed");
  assertModelCall(harness, 2, SELECTION_A);
  assert.deepEqual(harness.selection(childSessionId), SELECTION_A);
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);
});

test("非组 child 的 override 首轮不落 permanent pin；移除 override 后冷恢复按 profile 固定选择", async () => {
  const override = createSelection("demo", "override-model", "high");
  const profileSelection = createSelection("demo", "model-a", "low");
  const harness = createPinningHarness({
    profile: pinnedProfile({ modelGroupIntent: undefined, modelSelection: profileSelection }),
    parentSelection: PARENT_SELECTION,
    groups: [],
  });

  const first = await harness.run(undefined, {
    modelOverride: { selection: override, background: "deny" },
  });
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);
  assertModelCall(harness, 0, override);
  assert.ok(
    harness.shared.factorySelections.some(
      (entry) =>
        entry.providerId === override.providerId &&
        entry.modelId === override.modelId &&
        entry.reasoningLevel === "high",
    ),
    "非组 child 的 override 首轮构造期 model factory 必须收到 override",
  );
  assert.equal(harness.selection(childSessionId), undefined);

  // 父 runtime 重建后（冷恢复）不带 override：按 profile 解析并固定为该 child 的选择。
  const continued = await harness.rebuildParent().send(String(first.agentId));
  assert.equal(continued.status, "success");
  assert.equal(continued.continuation?.status, "completed");
  assertModelCall(harness, 1, profileSelection);
  assert.deepEqual(harness.selection(childSessionId), profileSelection);

  // 再来一次仍用已固定的选择，不被 override 历史影响。
  const again = await harness.send(String(first.agentId));
  assert.equal(again.continuation?.status, "completed");
  assertModelCall(harness, 2, profileSelection);
});

/**
 * child 自己 runtime 的内存组状态（Fork 读取源）必须与持久 entry 同源：
 * 首次钉死、沿用、重钉和 Fork 复制后都要能在 ModelSelected 时读到同一个 seed。
 * 此前只有 store entry 断言，Fork 从 runtime 内存读 state 的缺口未被覆盖。
 */
test("child runtime 内存组状态与持久 entry 一致：首次 / 沿用 / 重钉 / Fork 原种子", async (t) => {
  const observed: Array<{ sessionId: string; state: unknown }> = [];
  const originalEmit = AgentRuntime.prototype.emitModelSelected;
  t.mock.method(
    AgentRuntime.prototype,
    "emitModelSelected",
    async function (
      this: AgentRuntime,
      options: Parameters<AgentRuntime["emitModelSelected"]>[0],
    ): Promise<void> {
      // ModelSelected 在 setSessionModelGroupState 之后发布，正好可观测 child 内存状态。
      observed.push({ sessionId: String(this.sessionId), state: this.getSessionModelGroupState() });
      return originalEmit.call(this, options);
    },
  );
  const assertMemoryMatchesPersisted = (harness: PinningHarness, sessionId: string): void => {
    const seen = observed.filter((entry) => entry.sessionId === sessionId);
    assert.ok(seen.length > 0, `expected child runtime ModelSelected for ${sessionId}`);
    assert.deepEqual(seen.at(-1)?.state, harness.groupState(sessionId as never));
  };

  const harness = createPinningHarness({
    profile: pinnedProfile(),
    parentSelection: PARENT_SELECTION,
    groups: [createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberA()] })],
  });

  const first = await harness.run();
  assert.equal(first.status, "completed");
  const childSessionId = String(first.childSessionId);
  assertMemoryMatchesPersisted(harness, childSessionId);
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);

  // 沿用：候选池不改变绑定，内存与持久仍是同一份状态。
  const reused = await harness.send(String(first.agentId));
  assert.equal(reused.continuation?.status, "completed");
  assertMemoryMatchesPersisted(harness, childSessionId);
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);

  // 重钉：原成员离组，seed 不变，内存状态同步新选择所对应的组状态。
  harness.shared.groups = [
    createPinnedGroup({ groupId: GROUP_ID, name: "固定组", members: [memberB()] }),
  ];
  const repinned = await harness.send(String(first.agentId));
  assert.equal(repinned.continuation?.status, "completed");
  assertModelCall(harness, 2, SELECTION_B);
  assertMemoryMatchesPersisted(harness, childSessionId);
  assert.equal(harness.groupState(childSessionId)?.pickSeed, childSessionId);

  // Fork：复制 child 的 selection + group entry 到新 child，源 seed 必须原样进入内存。
  const forkedChildSessionId = createSessionId();
  const forkedAgentId = "agent_forked_memory";
  const profile = pinnedProfile();
  await harness.shared.store.port.createSubagentChildSession!(
    {
      id: forkedChildSessionId,
      projectID: harness.parentSessionId as never,
      workspaceID: PINNING_WORKSPACE_IDENTITY as never,
      parentID: harness.parentSessionId,
      taskType: "subagent_child",
      slug: "forked-memory-child",
      directory: PINNING_WORKSPACE_ROOT,
      path: PINNING_WORKSPACE_ROOT,
      title: "forked memory child",
      version: "0.0.0",
    },
    {
      agentId: forkedAgentId,
      childSessionId: String(forkedChildSessionId),
      agentType: profile.name,
      profile: profile as unknown as Record<string, unknown>,
      workspaceIdentity: PINNING_WORKSPACE_IDENTITY,
      workspaceRoot: PINNING_WORKSPACE_ROOT,
      contextResetGeneration: 0,
    },
  );
  for (const type of [SESSION_ENTRY_MODEL_SELECTION, SESSION_ENTRY_MODEL_GROUP]) {
    for (const entry of harness.shared.store.entriesFor(childSessionId, type)) {
      await harness.shared.store.port.saveSessionEntry!({
        ...entry,
        id: `${String(forkedChildSessionId)}:${type}`,
        sessionID: forkedChildSessionId,
      });
    }
  }

  const forked = await harness.rebuildParent().send(forkedAgentId);
  assert.equal(forked.continuation?.status, "completed");
  assertMemoryMatchesPersisted(harness, String(forkedChildSessionId));
  assert.equal(
    harness.groupState(String(forkedChildSessionId))?.pickSeed,
    childSessionId,
    "Fork 后 child runtime 内存种子必须是源 child ID",
  );
});
