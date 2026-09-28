import assert from "node:assert/strict";
import test from "node:test";
import {
  findGoalCommandTokenStart,
  hasGoalCommandToken,
  sliceGoalCommandArgs,
} from "../src/goal-command-token.js";

test("顶格与空白前的 /goal 都能命中", () => {
  assert.equal(findGoalCommandTokenStart("/goal 修复"), 0);
  assert.equal(findGoalCommandTokenStart("前文 /goal 修复") > 0, true);
  assert.equal(hasGoalCommandToken("前缀/goal 修复"), false);
});

test("中文句号后无空格仍命中，汉字紧邻不命中", () => {
  assert.equal(hasGoalCommandToken("关系。/goal 一直分析"), true);
  assert.equal(sliceGoalCommandArgs("关系。/goal 一直分析"), "一直分析");
  assert.equal(hasGoalCommandToken("前缀/goal 修复"), false);
});
