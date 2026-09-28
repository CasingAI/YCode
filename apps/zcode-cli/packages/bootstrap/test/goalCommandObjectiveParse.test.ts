import assert from "node:assert/strict";
import test from "node:test";
import { parseGoalObjectiveFromCommandText } from "../src/zcode-protocol-v4/commands/handlers/goal-command-objective.js";

test("顶格 /goal 只取目标正文", () => {
  assert.equal(parseGoalObjectiveFromCommandText("/goal 修复登录"), "修复登录");
});

test("句中 /goal 丢弃前文，只取 token 之后", () => {
  assert.equal(
    parseGoalObjectiveFromCommandText("关系。/goal 一直分析，分析到你能理解为止"),
    "一直分析，分析到你能理解为止",
  );
});

test("replace 前缀同样剥掉", () => {
  assert.equal(parseGoalObjectiveFromCommandText("/goal replace 新的目标"), "新的目标");
  assert.equal(parseGoalObjectiveFromCommandText("前文。/goal replace 新的目标"), "新的目标");
});

test("没有 goal token 时返回整段 trim", () => {
  assert.equal(parseGoalObjectiveFromCommandText("普通提问"), "普通提问");
});
