import assert from "node:assert/strict";
import test from "node:test";
import { isBotSessionRecordId } from "@zcode/shared";
import { isTaskListSessionType } from "../src/zcode-protocol-v4/task-list-session-membership.js";

test("岗位会话不进任务列表", () => {
  assert.equal(isTaskListSessionType("bot-session"), false);
  assert.equal(isTaskListSessionType("ai_history_search"), false);
  assert.equal(isTaskListSessionType("interactive"), true);
  assert.equal(isBotSessionRecordId("sess_botsess_abc"), true);
  assert.equal(isBotSessionRecordId("sess_plain"), false);
});
