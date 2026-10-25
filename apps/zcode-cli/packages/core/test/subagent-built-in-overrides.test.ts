// 内置子智能体覆盖表寻址（docs/specs/team-mode.md）：覆盖表按存储层内置名寻址
// （general-purpose / Explore），与 agents-state.json、设置页回写一致。
// Worker（SmartWorker）已废弃；agents-state.json 里的遗留 Worker 键由 Partial 天然忽略。
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelGroupIntent, ModelSelection } from "@zcode/shared";
import { normalizeAgentProfiles, type AgentProfile } from "../src/subagent/profile.js";
import { resolveSubagentSelectionAsync } from "../src/runtime/helpers/subagent-selection.js";

const GROUP_INTENT: ModelGroupIntent = {
  groupId: "model-group:free",
  groupNameSnapshot: "免费组",
};
const SELECTION: ModelSelection = { providerId: "zcode", modelId: "glm-5" };

function findProfile(profiles: readonly AgentProfile[], name: string): AgentProfile | undefined {
  return profiles.find((profile) => profile.name === name);
}

test("组意图覆盖按存储层内置名落到对应内置 profile", () => {
  const profiles = normalizeAgentProfiles([], {
    builtInModelGroupIntentOverrides: {
      "general-purpose": GROUP_INTENT,
      Explore: GROUP_INTENT,
    },
  });
  assert.deepEqual(findProfile(profiles, "general-purpose")?.modelGroupIntent, GROUP_INTENT);
  assert.deepEqual(findProfile(profiles, "Explore")?.modelGroupIntent, GROUP_INTENT);
  // Worker 已废弃：遗留 SmartWorker profile 不再注册。
  assert.equal(findProfile(profiles, "SmartWorker"), undefined);
});

test("具体模型覆盖同样按存储层内置名寻址", () => {
  const profiles = normalizeAgentProfiles([], {
    builtInModelSelectionOverrides: {
      "general-purpose": SELECTION,
      Explore: SELECTION,
    },
  });
  assert.deepEqual(findProfile(profiles, "general-purpose")?.modelSelection, SELECTION);
  assert.deepEqual(findProfile(profiles, "Explore")?.modelSelection, SELECTION);
});

test("没有覆盖时内置 profile 不带模型意图", () => {
  const profiles = normalizeAgentProfiles([]);
  assert.equal(findProfile(profiles, "general-purpose")?.modelSelection, undefined);
  assert.equal(findProfile(profiles, "Explore")?.modelGroupIntent, undefined);
  assert.equal(findProfile(profiles, "SmartWorker"), undefined);
});

test("profile 带组意图时子会话用组钉死结果，不继承父模型", async () => {
  const profiles = normalizeAgentProfiles([], {
    builtInModelGroupIntentOverrides: { Explore: GROUP_INTENT },
  });
  const explore = findProfile(profiles, "Explore");
  assert.ok(explore?.modelGroupIntent, "Explore profile 必须带组意图");
  const resolved = await resolveSubagentSelectionAsync({
    profileGroupIntent: explore.modelGroupIntent,
    // 父会话跑的是另一个模型；组在即不得继承父模型。
    parentSelection: { providerId: "zcode", modelId: "parent-model" },
    resolveGroupSelection: async () => ({ providerId: "zcode", modelId: "glm-5" }),
  });
  assert.deepEqual(resolved.selection, { providerId: "zcode", modelId: "glm-5" });
  assert.equal(resolved.hasConcreteModel, true);
});

test("组意图没有可用组名单时拒绝启动，不回落父模型", async () => {
  const profiles = normalizeAgentProfiles([], {
    builtInModelGroupIntentOverrides: { Explore: GROUP_INTENT },
  });
  const explore = findProfile(profiles, "Explore");
  await assert.rejects(
    resolveSubagentSelectionAsync({
      profileGroupIntent: explore?.modelGroupIntent,
      parentSelection: { providerId: "zcode", modelId: "parent-model" },
    }),
    /modelGroup\.deleted/,
  );
});
