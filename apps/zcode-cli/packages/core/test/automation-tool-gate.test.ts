import assert from "node:assert/strict";
import test from "node:test";
import { createToolRegistry } from "../src/tool/registry.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";

const CRON_TOOL_NAMES = ["CronCreate", "CronList", "CronUpdate", "CronDelete"];

test("Cron 四工具缺省不注册（automationEnabled 默认关闭）", () => {
  const registry = createToolRegistry();
  // 缺席即关闭：与 desktop 默认行为一致，不传 includeAutomation。
  registerBuiltInTools(registry, {});
  for (const name of CRON_TOOL_NAMES) {
    assert.equal(registry.has(name), false, `${name} 不应注册`);
  }
});

test("Cron 四工具显式开启才注册", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, { includeAutomation: true });
  for (const name of CRON_TOOL_NAMES) {
    assert.equal(registry.has(name), true, `${name} 应当注册`);
  }
});
