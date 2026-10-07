import assert from "node:assert/strict";
import test from "node:test";
import { modeRestrictsGoalCommands } from "../src/v4/goalCommandSendGate.js";

// 受限档 Goal 门禁——面板候选排除（docs/specs/goal-command-scope-and-decoration.md）：
// Plan / Ask 下 `/` 面板不给 goal/target 候选；发送按钮保持可点，拦截在发送时
// （SessionPane 门禁弹 toast），不按输入内容置灰按钮。

test("modeRestrictsGoalCommands：受限档排除面板候选，与提交档位同一份解析", () => {
  assert.equal(modeRestrictsGoalCommands("plan"), true);
  assert.equal(modeRestrictsGoalCommands("readonly"), true);
  assert.equal(modeRestrictsGoalCommands("yolo"), false);
  assert.equal(modeRestrictsGoalCommands(undefined), false);
  assert.equal(modeRestrictsGoalCommands("build"), false);
});
