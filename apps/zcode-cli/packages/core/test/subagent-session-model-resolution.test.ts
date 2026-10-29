// 子智能体固定绑定（docs/specs/model-group.md 场景 33-37）：
// 恢复已启动的 child 时复用 child 自己的选择/组状态，不按父模型或最新 profile 重算。
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_ENTRY_MODEL_GROUP, SESSION_ENTRY_MODEL_SELECTION } from "@zcode/contracts";
import type { ModelGroupIntent, ModelSelection, SessionStorePort } from "@zcode/contracts";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import { resolveSubagentSessionModel } from "../src/runtime/helpers/subagent-session-model.js";
import { persistRuntimeModelSelection } from "../src/runtime/methods/turn-model.js";

const GROUP_A = {
  groupId: "model-group:a",
  name: "组 A",
  memberOrder: [
    {
      providerId: "zcode",
      modelId: "glm-5",
      reasoningLevel: "low",
      supportedReasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
    },
    {
      providerId: "zcode",
      modelId: "glm-4",
      supportedReasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
    },
  ],
};
const GROUP_B = {
  groupId: "model-group:b",
  name: "组 B",
  memberOrder: [
    {
      providerId: "zcode",
      modelId: "b-model",
      supportedReasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
    },
  ],
};
const INTENT_A: ModelGroupIntent = { groupId: GROUP_A.groupId, groupNameSnapshot: GROUP_A.name };
const INTENT_B: ModelGroupIntent = { groupId: GROUP_B.groupId, groupNameSnapshot: GROUP_B.name };
const SELECTION_A: ModelSelection = {
  providerId: "zcode",
  modelId: "glm-5",
  options: { reasoningLevel: "low" },
};

function resolveSelection(selection: ModelSelection): EffectiveModelSelectionResult {
  return { effectiveSelection: selection };
}

function createSessionStore(
  entries: Partial<Record<string, unknown[]>> = {},
): Pick<SessionStorePort, "sessionEntries"> {
  return {
    async sessionEntries(input) {
      const type = input.type;
      const data = type ? (entries[type] ?? []) : [];
      return data.map((entry, index) => ({
        id: `entry-${String(index)}`,
        sessionID: input.sessionID,
        type: type ?? SESSION_ENTRY_MODEL_SELECTION,
        time: { created: 0, updated: 0 },
        data: entry,
      }));
    },
  } as Pick<SessionStorePort, "sessionEntries">;
}

function baseInput(overrides: {
  store?: Partial<Record<string, unknown[]>>;
  childSessionId?: string;
  resumesExistingChild?: boolean;
  profileSelection?: ModelSelection | null;
  profileGroupIntent?: ModelGroupIntent | null;
  parentSelection?: ModelSelection | null;
  overrideSelection?: ModelSelection;
  groups?: readonly unknown[];
}) {
  return {
    sessionStore: createSessionStore(overrides.store),
    childSessionId: overrides.childSessionId ?? "child-1",
    resumesExistingChild: overrides.resumesExistingChild ?? true,
    profileSelection: overrides.profileSelection ?? null,
    profileGroupIntent: overrides.profileGroupIntent ?? null,
    parentSelection: overrides.parentSelection ?? null,
    overrideSelection: overrides.overrideSelection,
    resolveSelection,
    listModelGroupSnapshots: async () => (overrides.groups ?? [GROUP_A]) as never,
  };
}

test("恢复旧 child：无组条目但有具体选择与 profile 组意图时沿用选择并补写 seed=childId", async () => {
  const resolution = await resolveSubagentSessionModel(
    baseInput({
      store: {
        [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
      },
      childSessionId: "child-legacy",
      profileGroupIntent: INTENT_A,
    }),
  );
  assert.deepEqual(resolution.selection, SELECTION_A);
  assert.equal(resolution.hasConcreteModel, true);
  assert.deepEqual(resolution.previousSelection, SELECTION_A);
  assert.deepEqual(resolution.groupState, {
    intent: INTENT_A,
    pickSeed: "child-legacy",
  });
  // 旧 child 的选择已经落盘，恢复沿用不需要重写具体选择；组状态仍需补进 runtime 内存并持久化。
  assert.equal(resolution.modelSelectionToPersist, undefined);
  assert.equal(resolution.persistGroupState, true);
});

test("恢复组 child：selectable/时段/新增成员都不改变已有绑定与用户调过的档位", async () => {
  const changedGroup = {
    groupId: GROUP_A.groupId,
    name: GROUP_A.name,
    memberOrder: [
      { ...GROUP_A.memberOrder[0]!, selectable: false },
      {
        ...GROUP_A.memberOrder[1]!,
        deprioritizeSchedule: {
          timeZone: "UTC",
          windows: [{ daysOfWeek: [1], startTime: "00:00", endTime: "24:00" }],
        },
      },
      { providerId: "zcode", modelId: "glm-new", supportedReasoningLevels: ["low"] },
    ],
  };
  const resolution = await resolveSubagentSessionModel({
    ...baseInput({
      store: {
        [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
        [SESSION_ENTRY_MODEL_GROUP]: [{ intent: INTENT_A, pickSeed: "seed-stable" }],
      },
      profileGroupIntent: INTENT_A,
      groups: [changedGroup],
    }),
  });
  assert.deepEqual(resolution.selection, SELECTION_A);
  assert.deepEqual(resolution.previousSelection, SELECTION_A);
  assert.deepEqual(resolution.groupState, { intent: INTENT_A, pickSeed: "seed-stable" });
  assert.equal(resolution.persistGroupState, false);
  assert.equal(resolution.modelSelectionToPersist, undefined);
});

test("新 child 首次模型选择持久化失败时拒绝启动", async () => {
  await assert.rejects(
    persistRuntimeModelSelection(
      {
        sessionId: "child-failing-write",
        sessionStore: {
          async saveSessionEntry() {
            throw new Error("first model-selection write failed");
          },
        },
      } as never,
      SELECTION_A,
      { strict: true },
    ),
    /failed to persist child model selection/,
  );
});

test("新 child 首次组选择要求严格提交模型绑定与组状态", async () => {
  const resolution = await resolveSubagentSessionModel(
    baseInput({ resumesExistingChild: false, profileGroupIntent: INTENT_A }),
  );
  assert.deepEqual(resolution.modelSelectionToPersist, resolution.selection);
  assert.equal(resolution.persistGroupState, true);
});

test("新 child 首次按 child ID 钉死，并返回待持久化的组状态", async () => {
  const resolution = await resolveSubagentSessionModel(
    baseInput({
      resumesExistingChild: false,
      childSessionId: "child-new",
      profileGroupIntent: INTENT_A,
    }),
  );
  assert.ok(["glm-5", "glm-4"].includes(resolution.selection.modelId));
  assert.equal(resolution.hasConcreteModel, true);
  assert.equal(resolution.previousSelection, undefined);
  assert.deepEqual(resolution.modelSelectionToPersist, resolution.selection);
  assert.equal(resolution.persistGroupState, true);
  assert.deepEqual(resolution.groupState, {
    intent: INTENT_A,
    pickSeed: "child-new",
  });
});

test("恢复已有 pin 用保存的档位验证，不受组默认档变化影响", async () => {
  const selectionLevels: string[] = [];
  const groupWithoutDefault = {
    groupId: GROUP_A.groupId,
    name: GROUP_A.name,
    memberOrder: [
      {
        providerId: SELECTION_A.providerId,
        modelId: SELECTION_A.modelId,
        supportedReasoningLevels: ["low", "high"],
      },
    ],
  };
  const resolution = await resolveSubagentSessionModel({
    ...baseInput({
      store: {
        [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
        [SESSION_ENTRY_MODEL_GROUP]: [{ intent: INTENT_A, pickSeed: "seed-stable" }],
      },
      profileGroupIntent: INTENT_A,
      groups: [groupWithoutDefault],
    }),
    resolveSelection: (selection) => {
      const level = selection.options?.reasoningLevel;
      selectionLevels.push(level ?? "<missing>");
      return level === "low"
        ? { effectiveSelection: selection }
        : { effectiveSelection: null, selectionIssue: "reasoning-level-missing" };
    },
  });
  assert.deepEqual(resolution.selection, SELECTION_A);
  assert.ok(selectionLevels.length > 0);
  assert.ok(selectionLevels.every((level) => level === "low"));
});

test("恢复已有 pin 的已保存档位不可解析时拒绝绑定而不重钉", async () => {
  await assert.rejects(
    resolveSubagentSessionModel({
      ...baseInput({
        store: {
          [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
          [SESSION_ENTRY_MODEL_GROUP]: [{ intent: INTENT_A, pickSeed: "seed-stable" }],
        },
        profileGroupIntent: INTENT_A,
      }),
      resolveSelection: () => ({
        effectiveSelection: null,
        selectionIssue: "reasoning-level-not-supported",
      }),
    }),
    /model binding configuration is invalid|saved model pin reasoning level is no longer supported/,
  );
});

test("恢复组 child：原成员离组时按原种子合法重钉并回报旧实际模型", async () => {
  const withoutA = {
    groupId: GROUP_A.groupId,
    name: GROUP_A.name,
    memberOrder: [GROUP_A.memberOrder[1]!],
  };
  const resolution = await resolveSubagentSessionModel(
    baseInput({
      store: {
        [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
        [SESSION_ENTRY_MODEL_GROUP]: [{ intent: INTENT_A, pickSeed: "seed-stable" }],
      },
      profileGroupIntent: INTENT_A,
      groups: [withoutA],
    }),
  );
  assert.equal(resolution.selection.modelId, "glm-4");
  assert.deepEqual(resolution.previousSelection, SELECTION_A);
  assert.deepEqual(resolution.modelSelectionToPersist, resolution.selection);
  assert.deepEqual(resolution.groupState, {
    intent: INTENT_A,
    pickSeed: "seed-stable",
  });
});

test("恢复 child：已存在但损坏的选择或组状态拒绝重抽", async () => {
  for (const [entryType, data] of [
    [
      SESSION_ENTRY_MODEL_SELECTION,
      { providerId: "zcode", modelId: "glm-5", options: { unknown: true } },
    ],
    [
      SESSION_ENTRY_MODEL_GROUP,
      { intent: { groupId: "", groupNameSnapshot: "组 A" }, pickSeed: "seed" },
    ],
  ] as const) {
    await assert.rejects(
      resolveSubagentSessionModel(
        baseInput({
          store: { [entryType]: [data] },
          profileGroupIntent: INTENT_A,
          parentSelection: SELECTION_A,
        }),
      ),
      /model binding configuration is invalid/,
    );
  }
});

test("恢复组 child：resolver 映射已保存成员身份时拒绝使用映射目标", async () => {
  await assert.rejects(
    resolveSubagentSessionModel({
      ...baseInput({
        store: {
          [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
          [SESSION_ENTRY_MODEL_GROUP]: [{ intent: INTENT_A, pickSeed: "seed-stable" }],
        },
        profileGroupIntent: INTENT_A,
      }),
      resolveSelection: (selection) => ({
        effectiveSelection: {
          providerId: selection.providerId === "zcode" ? "mapped-provider" : selection.providerId,
          modelId: selection.providerId === "zcode" ? "mapped-model" : selection.modelId,
        },
      }),
    }),
    /modelGroup\.noMembers/,
  );
});

test("恢复组 child：以 child 持久组状态为准，不跟随 profile 改选的新组", async () => {
  const resolution = await resolveSubagentSessionModel(
    baseInput({
      store: {
        [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
        [SESSION_ENTRY_MODEL_GROUP]: [{ intent: INTENT_A, pickSeed: "seed-stable" }],
      },
      profileGroupIntent: INTENT_B,
      groups: [GROUP_A, GROUP_B],
    }),
  );
  assert.deepEqual(resolution.selection, SELECTION_A);
});

test("恢复组 child：组已删明确失败，不回落父模型", async () => {
  await assert.rejects(
    resolveSubagentSessionModel(
      baseInput({
        store: {
          [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
          [SESSION_ENTRY_MODEL_GROUP]: [{ intent: INTENT_A, pickSeed: "seed-stable" }],
        },
        profileGroupIntent: INTENT_A,
        groups: [],
      }),
    ),
    /modelGroup\.deleted/,
  );
});

test("环境中没有组快照入口时按组不可用拒绝，不回落父模型", async () => {
  await assert.rejects(
    resolveSubagentSessionModel({
      ...baseInput({ profileGroupIntent: INTENT_A }),
      listModelGroupSnapshots: undefined,
    }),
    /modelGroup\.deleted/,
  );
});

test("恢复组 child：无可用成员明确失败", async () => {
  await assert.rejects(
    resolveSubagentSessionModel({
      ...baseInput({
        store: {
          [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
          [SESSION_ENTRY_MODEL_GROUP]: [{ intent: INTENT_A, pickSeed: "seed-stable" }],
        },
        profileGroupIntent: INTENT_A,
      }),
      resolveSelection: () => ({ effectiveSelection: null, selectionIssue: "model-not-found" }),
    }),
    /modelGroup\.noMembers/,
  );
});

test("恢复非组具体模型 child：沿用 child 保存的选择，不随父模型变化", async () => {
  const parentSelection: ModelSelection = { providerId: "zcode", modelId: "parent-model" };
  const resolution = await resolveSubagentSessionModel(
    baseInput({
      store: {
        [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
      },
      profileSelection: { providerId: "zcode", modelId: "new-profile-model" },
      parentSelection,
    }),
  );
  assert.deepEqual(resolution.selection, SELECTION_A);
  assert.deepEqual(resolution.previousSelection, SELECTION_A);
  assert.equal(resolution.groupState, undefined);
});

test("恢复非组继承 child：使用已保存选择而不是当前父模型", async () => {
  const resolution = await resolveSubagentSessionModel(
    baseInput({
      store: {
        [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
      },
      parentSelection: { providerId: "zcode", modelId: "parent-model" },
    }),
  );
  assert.deepEqual(resolution.selection, SELECTION_A);
});

test("内部 execution override 保持最高优先级且不产生 child 绑定写入", async () => {
  const override: ModelSelection = { providerId: "zcode", modelId: "override-model" };
  const resolution = await resolveSubagentSessionModel(
    baseInput({
      store: {
        [SESSION_ENTRY_MODEL_SELECTION]: [SELECTION_A],
        [SESSION_ENTRY_MODEL_GROUP]: [{ intent: INTENT_A, pickSeed: "seed-stable" }],
      },
      profileGroupIntent: INTENT_A,
      overrideSelection: override,
    }),
  );
  assert.deepEqual(resolution.selection, override);
  assert.deepEqual(resolution.groupState, { intent: INTENT_A, pickSeed: "seed-stable" });
  assert.equal(resolution.persistGroupState, false);
  assert.equal(resolution.modelSelectionToPersist, undefined);
});

test("读取 child 模型绑定失败时拒绝启动", async () => {
  await assert.rejects(
    resolveSubagentSessionModel({
      ...baseInput({ profileGroupIntent: INTENT_A }),
      sessionStore: {
        async sessionEntries() {
          throw new Error("session store unavailable");
        },
      },
    }),
    /模型绑定|model binding|session store unavailable/i,
  );
});
