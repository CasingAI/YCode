import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_ASK_USER_TOOL,
  BOT_HOUSEKEEP_PROMPT,
  BOT_SEND_MESSAGE_TOOL,
  BOT_TASK_TOOL,
} from "@zcode/shared";
import { mergeProjectedTranscript } from "../src/bots/botRosterLogic.js";
import {
  projectBotTranscript,
  shouldShowBotWorking,
} from "../src/bots/botSessionProjection.js";
import type { BotTranscriptItem } from "../src/bots/botRosterTypes.js";

test("岗位投影只收下发短消息和询问，丢掉模型自由正文", () => {
  const items = projectBotTranscript({
    rows: [
      { kind: "userInput", origin: "realUser", text: "今晚加班吗", rowId: 1, createdAt: 1 },
      { kind: "assistantText", text: "长篇推理不该出现", rowId: 2, createdAt: 2 },
      {
        kind: "toolCall",
        toolName: BOT_SEND_MESSAGE_TOOL,
        input: { text: "今晚可以。要我盯进度吗？" },
        rowId: 3,
        createdAt: 3,
      },
    ],
  });
  assert.deepEqual(
    items.map((item) => item.kind),
    ["user", "bot"],
  );
  assert.equal(items[1]?.text, "今晚可以。要我盯进度吗？");
});

test("待应答的 bot_ask_user 进询问气泡，不走系统卡片", () => {
  const items = projectBotTranscript({
    rows: [
      {
        kind: "toolCall",
        toolName: BOT_ASK_USER_TOOL,
        input: {
          text: "今晚要加班吗？",
          choices: [
            { id: "yes", label: "好" },
            { id: "no", label: "先不用" },
          ],
        },
        rowId: 4,
        createdAt: 4,
      },
    ],
    pendingAsks: [
      {
        interactionId: "ask_1",
        toolName: BOT_ASK_USER_TOOL,
        prompt: "今晚要加班吗？",
        options: [
          { optionId: "yes", label: "好" },
          { optionId: "no", label: "先不用" },
        ],
      },
    ],
  });
  assert.equal(items[0]?.kind, "ask");
  assert.equal(items[0]?.interactionId, "ask_1");
  assert.equal(items[0]?.ask?.choices.length, 2);
});

test("派出工人的工具不进对话小条", () => {
  const items = projectBotTranscript({
    rows: [
      {
        kind: "toolCall",
        toolName: "Agent",
        status: "running",
        input: { description: "查今晚值班" },
        rowId: 5,
        createdAt: 5,
      },
      {
        kind: "toolCall",
        toolName: BOT_SEND_MESSAGE_TOOL,
        input: { text: "今晚有人值班。" },
        rowId: 6,
        createdAt: 6,
      },
    ],
  });
  assert.deepEqual(
    items.map((item) => item.kind),
    ["bot"],
  );
  assert.equal(items[0]?.text, "今晚有人值班。");
});

test("闲置家务输入不进气泡", () => {
  const items = projectBotTranscript({
    rows: [
      { kind: "userInput", origin: "realUser", text: BOT_HOUSEKEEP_PROMPT, rowId: 8, createdAt: 8 },
      {
        kind: "toolCall",
        toolName: BOT_TASK_TOOL,
        status: "completed",
        input: { action: "open", title: "盯今晚值班" },
        rowId: 9,
        createdAt: 9,
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "event");
  assert.equal(items[0]?.eventKind, "task");
  assert.equal(items[0]?.text, "盯今晚值班");
});

test("闲置压缩的 /compact 规范正文不进用户气泡", () => {
  const items = projectBotTranscript({
    rows: [
      {
        kind: "userInput",
        origin: "realUser",
        text: "/compact Persist durable notes with bot_memory. Do not call bot_send_message or bot_ask_user.",
        rowId: 20,
        createdAt: 20,
      },
      {
        kind: "userInput",
        origin: "realUser",
        text: "人说的正常话",
        rowId: 21,
        createdAt: 21,
      },
    ],
  });
  assert.deepEqual(
    items.map((item) => item.text),
    ["人说的正常话"],
  );
});

test("代发过程条带上目标任务 id，方便点进去", () => {
  const items = projectBotTranscript({
    rows: [
      {
        kind: "toolCall",
        toolName: BOT_TASK_TOOL,
        status: "completed",
        input: { action: "relay", sessionId: "sess_task_1", title: "帮我催一下" },
        rowId: 11,
        createdAt: 11,
      },
    ],
  });
  assert.equal(items[0]?.targetSessionId, "sess_task_1");
});

test("投影尚未带上刚发出的用户气泡时，本地那条仍保留", () => {
  const local: BotTranscriptItem[] = [
    { id: "msg_local", kind: "user", text: "刚发的", createdAt: 9 },
  ];
  const projected: BotTranscriptItem[] = [
    { id: "row_1", kind: "bot", text: "上一句回复", createdAt: 1, sourceId: "send:1" },
  ];
  const merged = mergeProjectedTranscript(local, projected);
  assert.equal(merged.at(-1)?.text, "刚发的");
});

test("空投影不抹掉已有对话", () => {
  const existing: BotTranscriptItem[] = [
    { id: "msg_1", kind: "user", text: "你好", createdAt: 1, sourceId: "user:1" },
    { id: "msg_2", kind: "bot", text: "嗨", createdAt: 2, sourceId: "send:2" },
    { id: "msg_local", kind: "user", text: "下一句", createdAt: 3 },
  ];
  const merged = mergeProjectedTranscript(existing, []);
  assert.equal(merged.length, 3);
  assert.equal(merged.at(-1)?.text, "下一句");
});

test("短消息已上屏且无工人时，running 不粘滞占线", () => {
  const transcript: BotTranscriptItem[] = [
    { id: "u1", kind: "user", text: "在吗", createdAt: 1 },
    { id: "b1", kind: "bot", text: "在的", createdAt: 2, sourceId: "send:1" },
  ];
  assert.equal(
    shouldShowBotWorking({ phase: "running", workerRunning: false, transcript }),
    false,
  );
  assert.equal(
    shouldShowBotWorking({ phase: "running", workerRunning: true, transcript }),
    true,
  );
  assert.equal(
    shouldShowBotWorking({
      phase: "running",
      workerRunning: false,
      transcript: [{ id: "u2", kind: "user", text: "下一句", createdAt: 3 }],
    }),
    true,
  );
  assert.equal(
    shouldShowBotWorking({ phase: "idle", workerRunning: false, transcript }),
    false,
  );
});
