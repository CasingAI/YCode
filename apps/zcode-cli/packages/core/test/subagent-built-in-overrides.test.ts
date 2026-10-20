// 内置子智能体覆盖表寻址（docs/specs/bare-worker.md）：覆盖表按存储层内置名寻址
// （general-purpose / Explore / Worker），与 agents-state.json、设置页回写一致。
// 运行时的 Worker profile 名是 SmartWorker（模型可见 subagent_type），那是另一套命名空间；
// 两者混用会让覆盖查不到，子会话静默继承父模型（组意图看起来「没生效」）。
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
      Worker: GROUP_INTENT,
    },
  });
  assert.deepEqual(findProfile(profiles, "general-purpose")?.modelGroupIntent, GROUP_INTENT);
  assert.deepEqual(findProfile(profiles, "Explore")?.modelGroupIntent, GROUP_INTENT);
  // Worker 的运行时 profile 名是 SmartWorker，覆盖仍按存储层键名 Worker 寻址。
  assert.deepEqual(findProfile(profiles, "SmartWorker")?.modelGroupIntent, GROUP_INTENT);
});

test("具体模型覆盖同样按存储层内置名寻址", () => {
  const profiles = normalizeAgentProfiles([], {
    builtInModelSelectionOverrides: {
      "general-purpose": SELECTION,
      Explore: SELECTION,
      Worker: SELECTION,
    },
  });
  assert.deepEqual(findProfile(profiles, "general-purpose")?.modelSelection, SELECTION);
  assert.deepEqual(findProfile(profiles, "Explore")?.modelSelection, SELECTION);
  assert.deepEqual(findProfile(profiles, "SmartWorker")?.modelSelection, SELECTION);
});

test("没有覆盖时内置 profile 不带模型意图", () => {
  const profiles = normalizeAgentProfiles([]);
  assert.equal(findProfile(profiles, "general-purpose")?.modelSelection, undefined);
  assert.equal(findProfile(profiles, "Explore")?.modelGroupIntent, undefined);
  assert.equal(findProfile(profiles, "SmartWorker")?.modelGroupIntent, undefined);
});

test("profile 带组意图时子会话用组钉死结果，不继承父模型", async () => {
  const profiles = normalizeAgentProfiles([], {
    builtInModelGroupIntentOverrides: { Worker: GROUP_INTENT },
  });
  const worker = findProfile(profiles, "SmartWorker");
  assert.ok(worker?.modelGroupIntent, "SmartWorker profile 必须带组意图");
  const resolved = await resolveSubagentSelectionAsync({
    profileGroupIntent: worker.modelGroupIntent,
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
