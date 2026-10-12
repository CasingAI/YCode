import assert from "node:assert/strict";
import test from "node:test";
import { isCoreError } from "@zcode/contracts";
import {
  formatAgentProfilesForPrompt,
  normalizeAgentProfiles,
  type AgentProfile,
} from "../src/subagent/profile.js";
import { createAgentToolEntry } from "../src/tool/handlers/agent.js";
import {
  BARE_BUILTIN_REPLACED_RULE_ID,
  WORKER_MODE_SWITCH_UNSUPPORTED_RULE_ID,
  WORKER_MODE_SWITCH_WHILE_RUNNING_RULE_ID,
  WORKER_PARENT_REQUIRED_RULE_ID,
  defaultSubagentTypeForParentMode,
  denySubagentTypeForParentMode,
  denyWorkerModeSwitchOnSend,
  filterAgentProfilesForParentMode,
  formatSubagentSpawnModeLabel,
  parseSubagentSpawnModeLabel,
} from "../src/subagent/worker-dispatch.js";

function ruleIdOf(error: unknown): unknown {
  assert.equal(isCoreError(error), true);
  return isCoreError(error) ? error.context?.ruleId : undefined;
}

function customReviewer(): AgentProfile {
  return {
    name: "reviewer",
    description: "Custom reviewer",
    source: "user",
    systemPrompt: "review",
    tools: ["Read"],
  };
}

test("Bare 父未写类型缺省 Worker，其它档缺省通用", () => {
  assert.equal(defaultSubagentTypeForParentMode("bare"), "Worker");
  assert.equal(defaultSubagentTypeForParentMode("yolo"), "general-purpose");
  assert.equal(defaultSubagentTypeForParentMode("readonly"), "general-purpose");
  assert.equal(defaultSubagentTypeForParentMode("plan"), "general-purpose");
  assert.equal(defaultSubagentTypeForParentMode(undefined), "general-purpose");
});

test("Bare 父可见列表含 Worker 与自定义，不含 Explore 与通用", () => {
  const profiles = filterAgentProfilesForParentMode(
    normalizeAgentProfiles([customReviewer()]),
    "bare",
  );
  const names = profiles.map((profile) => profile.name);
  assert.equal(names.includes("Worker"), true);
  assert.equal(names.includes("reviewer"), true);
  assert.equal(names.includes("Explore"), false);
  assert.equal(names.includes("general-purpose"), false);
});

test("Ask / Plan / Agent 父可见列表含 Explore 与通用，不含 Worker", () => {
  for (const parentMode of ["readonly", "plan", "yolo"] as const) {
    const names = filterAgentProfilesForParentMode(
      normalizeAgentProfiles([customReviewer()]),
      parentMode,
    ).map((profile) => profile.name);
    assert.equal(names.includes("Worker"), false, parentMode);
    assert.equal(names.includes("Explore"), true, parentMode);
    assert.equal(names.includes("general-purpose"), true, parentMode);
    assert.equal(names.includes("reviewer"), true, parentMode);
  }
});

test("非 Bare 父派 Worker 硬拒绝", () => {
  for (const parentMode of ["readonly", "plan", "yolo", undefined] as const) {
    try {
      denySubagentTypeForParentMode(parentMode, { name: "Worker", source: "built-in" });
      assert.fail(`expected deny for ${parentMode}`);
    } catch (error) {
      assert.equal(ruleIdOf(error), WORKER_PARENT_REQUIRED_RULE_ID);
    }
  }
});

test("Bare 父派 Explore 或通用硬拒绝", () => {
  for (const name of ["Explore", "general-purpose"] as const) {
    try {
      denySubagentTypeForParentMode("bare", { name, source: "built-in" });
      assert.fail(`expected deny for ${name}`);
    } catch (error) {
      assert.equal(ruleIdOf(error), BARE_BUILTIN_REPLACED_RULE_ID);
    }
  }
});

test("Bare 父派 Worker 或自定义类型放行", () => {
  denySubagentTypeForParentMode("bare", { name: "Worker", source: "built-in" });
  denySubagentTypeForParentMode("bare", { name: "reviewer", source: "user" });
});

test("派出档位标签只映射 Ask / Agent", () => {
  assert.equal(parseSubagentSpawnModeLabel("Ask"), "readonly");
  assert.equal(parseSubagentSpawnModeLabel("Agent"), "yolo");
  assert.equal(parseSubagentSpawnModeLabel(undefined), undefined);
  assert.equal(formatSubagentSpawnModeLabel("readonly"), "Ask");
  assert.equal(formatSubagentSpawnModeLabel("yolo"), "Agent");
  assert.equal(formatSubagentSpawnModeLabel("bare"), undefined);
});

test("运行中带档整次拒绝，非 Worker 带档拒绝，终态 Worker 放行", () => {
  try {
    denyWorkerModeSwitchOnSend({
      permissionMode: "yolo",
      running: true,
      agentType: "Worker",
    });
    assert.fail("expected running deny");
  } catch (error) {
    assert.equal(ruleIdOf(error), WORKER_MODE_SWITCH_WHILE_RUNNING_RULE_ID);
  }
  try {
    denyWorkerModeSwitchOnSend({
      permissionMode: "readonly",
      running: false,
      agentType: "Explore",
    });
    assert.fail("expected non-worker deny");
  } catch (error) {
    assert.equal(ruleIdOf(error), WORKER_MODE_SWITCH_UNSUPPORTED_RULE_ID);
  }
  denyWorkerModeSwitchOnSend({
    permissionMode: "yolo",
    running: false,
    agentType: "Worker",
  });
  denyWorkerModeSwitchOnSend({
    permissionMode: undefined,
    running: true,
    agentType: "Worker",
  });
});

test("Bare 派出工具描述缺省 Worker，不推销 Explore 或通用", () => {
  const description = createAgentToolEntry({ parentMode: "bare" }).metadata.description ?? "";
  assert.match(description, /the Worker agent is used/);
  assert.match(description, /^- Worker:/m);
  assert.doesNotMatch(description, /^- Explore:/m);
  assert.doesNotMatch(description, /^- general-purpose:/m);
});

test("Agent 父派出工具描述缺省通用，不含 Worker", () => {
  const description = createAgentToolEntry({ parentMode: "yolo" }).metadata.description ?? "";
  assert.match(description, /the general-purpose agent is used/);
  assert.match(description, /^- Explore:/m);
  assert.match(description, /^- general-purpose:/m);
  assert.doesNotMatch(description, /^- Worker:/m);
});

test("Bare 父 prompt 类型列表与过滤结果一致", () => {
  const text = formatAgentProfilesForPrompt([customReviewer()], { parentMode: "bare" }) ?? "";
  assert.match(text, /^- Worker:/m);
  assert.match(text, /^- reviewer:/m);
  assert.doesNotMatch(text, /^- Explore:/m);
  assert.doesNotMatch(text, /^- general-purpose:/m);
});
