import assert from "node:assert/strict";
import test from "node:test";
import { buildBashDescriptionFieldPrompt } from "@zcode/contracts";
import { buildInheritedSubagentRuntimeConfig } from "../src/runtime/methods/subagent.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";

// 子代理 child runtime 的父会话继承集是「漏一个就静默退回默认」的地方：没有报错、没有
// 日志，只表现为子代理行为与主会话分裂。这里锁住两点——继承集本身覆盖哪些字段，以及
// 继承下来的会话语言确实能推出与主会话一致的工具提示文案。

function parentConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return { ...overrides };
}

test("继承集：父会话语言按原值透传，不补值也不归一", () => {
  assert.equal(
    buildInheritedSubagentRuntimeConfig(parentConfig({ language: "zh-CN" })).language,
    "zh-CN",
  );
  assert.equal(
    buildInheritedSubagentRuntimeConfig(parentConfig({ language: "en-US" })).language,
    "en-US",
  );
  // 未识别的语言标识同样原样带过去：是否支持由消费方（buildBashDescriptionFieldPrompt）判断，
  // 继承层不做第二份语言白名单，否则两处口径会漂移。
  assert.equal(
    buildInheritedSubagentRuntimeConfig(parentConfig({ language: "ja-JP" })).language,
    "ja-JP",
  );
});

test("继承集：父会话没有语言时保持缺席，不凭空断言语言", () => {
  const inherited = buildInheritedSubagentRuntimeConfig(parentConfig());

  assert.equal(inherited.language, undefined);
  assert.equal("language" in inherited, true);
  // 旧会话（升级前创建）没有语言事实，子代理必须与主会话一样退回默认文案，
  // 而不是被这里补成某种语言。
  assert.match(
    buildBashDescriptionFieldPrompt(inherited.language),
    /written in the user's language/,
  );
});

test("继承集：中文会话的子代理拿到与主会话一致的简体中文提示", () => {
  const inherited = buildInheritedSubagentRuntimeConfig(parentConfig({ language: "zh-CN" }));
  const childPrompt = buildBashDescriptionFieldPrompt(inherited.language);

  // 这是本继承项存在的唯一理由：Bash description 提示按会话语言选文案。
  assert.match(childPrompt, /必须用简体中文书写，不要使用其他语言/);
  assert.equal(childPrompt, buildBashDescriptionFieldPrompt("zh-CN"));
  // 回归防护：漏传 language 时子代理拿到的是英文默认文案，提示里不会有这条硬约束。
  assert.doesNotMatch(childPrompt, /written in the user's language/);
});

test("继承集：其余父会话标量配置一并透传", () => {
  const inherited = buildInheritedSubagentRuntimeConfig(
    parentConfig({
      modelStreaming: "on",
      midConversationSystem: { mode: "force" },
      dynamicWorkflowEnabled: false,
      toolDisallowlist: ["CreateWorkflow"],
      embeddedSearchBackend: "bfs",
      nativeSearchEnhancementsEnabled: false,
      modelContextBudgetStrategy: "legacy",
    }),
  );

  // dynamicWorkflowEnabled 的 false 必须原样带过去：灰度门是结构性约束，缺席即开启，
  // 一旦在这里丢成 undefined，子代理就成了绕过灰度的后门。
  assert.equal(inherited.dynamicWorkflowEnabled, false);
  assert.equal(inherited.modelStreaming, "on");
  assert.deepEqual(inherited.midConversationSystem, { mode: "force" });
  assert.deepEqual(inherited.toolDisallowlist, ["CreateWorkflow"]);
  assert.equal(inherited.embeddedSearchBackend, "bfs");
  assert.equal(inherited.nativeSearchEnhancementsEnabled, false);
  assert.equal(inherited.modelContextBudgetStrategy, "legacy");
});
