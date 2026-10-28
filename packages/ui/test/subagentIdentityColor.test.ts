import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubagentColorFromName, SUBAGENT_COLOR_CLASS, SUBAGENT_TEXT_COLOR_CLASS } from "../src/lib/subagentColors.js";

// 内置子智能体身份色 hash 兜底不变量（docs/specs/built-in-subagent-identity-color.md）：
// services 的显式身份色（通用 = red、探索 = green）必须与按英文名 hash 的兜底色一致，
// 否则 store 未就绪时聊天卡名称色会跳变。本测试守住 hash 一侧；显式色一侧由
// packages/services/test/subagentBuiltInColor.test.ts 守住。

test("内置身份名 hash 兜底色与显式身份色一致", () => {
  assert.equal(resolveSubagentColorFromName("general-purpose"), "red");
  assert.equal(resolveSubagentColorFromName("Explore"), "green");
});

test("red 与 green 都有 CSS 映射，消费面不允许落空", () => {
  assert.ok(SUBAGENT_COLOR_CLASS.red);
  assert.ok(SUBAGENT_COLOR_CLASS.green);
  assert.ok(SUBAGENT_TEXT_COLOR_CLASS.red);
  assert.ok(SUBAGENT_TEXT_COLOR_CLASS.green);
});
