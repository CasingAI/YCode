import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBotSessionSpeakReminderBody,
  buildRuntimeModeReminderBody,
} from "../src/runtime/helpers/runtime-reminders.js";

test("岗位出口提醒不含协作档 mode 标签", () => {
  const body = buildBotSessionSpeakReminderBody();
  assert.match(body, /bot_send_message/);
  assert.match(body, /Plain assistant text is never shown/);
  assert.doesNotMatch(body, /<mode>/);
});

test("协作会话仍注入 mode 标签", () => {
  assert.equal(buildRuntimeModeReminderBody("yolo"), "<mode>Agent</mode>");
  assert.equal(buildRuntimeModeReminderBody("bare"), "<mode>Bare</mode>");
});
