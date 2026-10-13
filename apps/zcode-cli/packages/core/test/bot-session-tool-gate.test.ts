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

const PROJECT_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Sandbox"];

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
  for (const name of PROJECT_TOOLS) {
    assert.equal(registry.has(name), false, `${name} 不应出现在岗位会话`);
  }
});
