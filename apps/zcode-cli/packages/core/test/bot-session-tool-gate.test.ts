import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_ASK_USER_TOOL_NAME,
  BOT_MEMORY_TOOL_NAME,
  BOT_SEND_MESSAGE_TOOL_NAME,
  BOT_TASK_TOOL_NAME,
} from "@zcode/contracts";
import { createToolRegistry } from "../src/tool/registry.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { refreshBranchAwareBuiltInTools } from "../src/runtime/methods/embedded-search-branch.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

const PROJECT_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "JSVM"];

test("岗位出口工具缺省不注册", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, {});
  assert.equal(registry.has(BOT_SEND_MESSAGE_TOOL_NAME), false);
  assert.equal(registry.has(BOT_ASK_USER_TOOL_NAME), false);
  assert.equal(registry.has(BOT_MEMORY_TOOL_NAME), false);
  assert.equal(registry.has(BOT_TASK_TOOL_NAME), false);
});

test("岗位会话注册出口工具并去掉项目文件工具", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, {
    includeBotSession: true,
    includeAgent: true,
    includeSendMessage: true,
    includeSkill: true,
  });
  assert.equal(registry.has(BOT_SEND_MESSAGE_TOOL_NAME), true);
  assert.equal(registry.has(BOT_ASK_USER_TOOL_NAME), true);
  assert.equal(registry.has(BOT_MEMORY_TOOL_NAME), true);
  assert.equal(registry.has(BOT_TASK_TOOL_NAME), true);
  assert.equal(registry.has("AskUserQuestion"), false);
  assert.equal(registry.has("RelayToSubagent"), false);
  for (const name of PROJECT_TOOLS) {
    assert.equal(registry.has(name), false, `${name} 不应出现在岗位会话`);
  }
});

test("岗位会话即使打开 includeSendMessage 也不注册 SendMessage", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, {
    includeBotSession: true,
    includeSendMessage: true,
    includeAgent: true,
  });
  assert.equal(registry.has(BOT_SEND_MESSAGE_TOOL_NAME), true);
  assert.equal(registry.has("RelayToSubagent"), false);
});

test("分支感知二次注册保持岗位工具门", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, {
    includeBotSession: true,
    includeAgent: true,
    includeSkill: true,
  });
  // 模拟旧 bug：二次注册漏传 includeBotSession，静默加回项目工具
  registerBuiltInTools(registry, {
    includeAgent: true,
    includeSkill: true,
    silentDuplicateWarnings: true,
  });
  assert.equal(registry.has("Read"), true);

  const runtime = {
    registry,
    config: { botSession: true },
    skillPort: {},
    subagentPort: {},
    cachedTools: null,
  } as unknown as AgentRuntimeInternal;

  refreshBranchAwareBuiltInTools(runtime);

  assert.equal(registry.has(BOT_SEND_MESSAGE_TOOL_NAME), true);
  assert.equal(registry.has(BOT_ASK_USER_TOOL_NAME), true);
  assert.equal(registry.has("AskUserQuestion"), false);
  assert.equal(registry.has("RelayToSubagent"), false);
  for (const name of PROJECT_TOOLS) {
    assert.equal(registry.has(name), false, `${name} 不应在二次注册后回来`);
  }
});
