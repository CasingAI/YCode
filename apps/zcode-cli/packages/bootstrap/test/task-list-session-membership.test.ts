import assert from "node:assert/strict";
import test from "node:test";
import { isTaskListSessionType } from "../src/zcode-protocol-v4/task-list-session-membership.js";

test("辅助会话不进任务列表", () => {
  assert.equal(isTaskListSessionType("ai_history_search"), false);
  assert.equal(isTaskListSessionType("interactive"), true);
});
