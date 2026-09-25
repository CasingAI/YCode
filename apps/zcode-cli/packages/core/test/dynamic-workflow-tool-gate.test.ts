import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeDynamicWorkflowToolsIncluded } from "../src/runtime/helpers/tool-allowlist.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";

function config(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return { ...overrides };
}

test("Dynamic Workflow 工具只有显式 true 才注册", () => {
  assert.equal(resolveRuntimeDynamicWorkflowToolsIncluded(config()), false);
  assert.equal(resolveRuntimeDynamicWorkflowToolsIncluded(config({ dynamicWorkflowEnabled: false })), false);
  assert.equal(resolveRuntimeDynamicWorkflowToolsIncluded(config({ dynamicWorkflowEnabled: true })), true);
});

test("非法旧值不会把 Dynamic Workflow 工具打开", () => {
  assert.equal(
    resolveRuntimeDynamicWorkflowToolsIncluded(
      config({ dynamicWorkflowEnabled: "enabled" as unknown as boolean }),
    ),
    false,
  );
});
