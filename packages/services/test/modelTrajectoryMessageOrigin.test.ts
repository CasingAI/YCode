import assert from "node:assert/strict";
import test from "node:test";
import {
  attachWireRoles,
  classifyMessageOrigins,
  normalizeMessageText,
} from "../src/zcode-agent/modelTrajectoryMessageOrigin.js";

// 轨迹消息来源分类（docs/specs/model-trajectory-message-origin.md）：
// 前导 system = 系统提示词；mid-conversation system / <system-reminder> 开头的 user = 运行时注入 reminder；
// 线上角色按内容匹配回填，不按位置对齐（SDK 视图与线上载荷是 1:N）。

const SYSTEM_PROMPT = "You are a coding agent.";

function system(text: string) {
  return { role: "system", content: text };
}

function user(text: string) {
  return { role: "user", content: text };
}

function reminderUser(body: string) {
  return { role: "user", content: `<system-reminder>\n${body}\n</system-reminder>` };
}

function assistant(text: string) {
  return { role: "assistant", content: text };
}

test("前导连续 system 分类为 system-prompt，mid-conversation system 分类为 system-reminder", () => {
  const origins = classifyMessageOrigins([
    system(SYSTEM_PROMPT),
    system("extra prefix block"),
    user("现在呢"),
    system("Full access mode is active: permission prompts are disabled."),
    assistant("ok"),
  ]);

  assert.deepEqual(
    origins.map((entry) => entry.origin),
    ["system-prompt", "system-prompt", "conversation", "system-reminder", "conversation"],
  );
});

test("user 消息以 <system-reminder> 开头分类为 system-reminder（MCS 降级形态）", () => {
  const origins = classifyMessageOrigins([
    system(SYSTEM_PROMPT),
    user("这个系统消息是什么？"),
    reminderUser("Full access mode is active"),
  ]);

  assert.equal(origins[0]?.origin, "system-prompt");
  assert.equal(origins[1]?.origin, "conversation");
  assert.equal(origins[2]?.origin, "system-reminder");
});

test("真实用户消息中后部附带 reminder 块仍是 conversation", () => {
  const origins = classifyMessageOrigins([
    system(SYSTEM_PROMPT),
    user("这个系统消息是什么？\n<system-reminder>\ncontext block\n</system-reminder>"),
  ]);

  assert.equal(origins[1]?.origin, "conversation");
});

test("无前导 system 时首条 system 也按 mid-conversation 注入处理", () => {
  const origins = classifyMessageOrigins([user("hi"), system("injected")]);
  assert.equal(origins[0]?.origin, "conversation");
  assert.equal(origins[1]?.origin, "system-reminder");
});

test("attachWireRoles 按归一化文本匹配线上角色，content 块数组与字符串等价", () => {
  const messages = [
    system(SYSTEM_PROMPT),
    user("现在呢"),
    { role: "system", content: "Full access mode is active" },
    reminderUser("Full access mode is active"),
  ];
  const classifications = classifyMessageOrigins(messages);
  const wire = [
    { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
    { role: "user", content: [{ type: "text", text: "现在呢" }] },
    { role: "system", content: [{ type: "text", text: "Full access mode is active" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>\nFull access mode is active\n</system-reminder>" },
      ],
    },
  ];

  attachWireRoles(messages, classifications, wire);

  assert.equal(classifications[0]?.origin, "system-prompt");
  assert.equal(classifications[0]?.wireRole, undefined);
  assert.equal(classifications[2]?.wireRole, "system");
  assert.equal(classifications[3]?.wireRole, "user");
});

test("attachWireRoles 同文本多次注入逐条消费，不重复占用同一条线上消息", () => {
  const reminder = "Read-only mode still active";
  const messages = [
    system(SYSTEM_PROMPT),
    user("hi"),
    { role: "system", content: reminder },
    assistant("done"),
    { role: "system", content: reminder },
  ];
  const classifications = classifyMessageOrigins(messages);
  const wire = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "hi" },
    { role: "user", content: reminder },
    { role: "system", content: reminder },
  ];

  attachWireRoles(messages, classifications, wire);

  assert.equal(classifications[2]?.wireRole, "user");
  assert.equal(classifications[4]?.wireRole, "system");
});

test("attachWireRoles 无线上载荷或不匹配时不设置 wireRole", () => {
  const messages = [user("hi"), { role: "system", content: "injected" }];
  const classifications = classifyMessageOrigins(messages);

  attachWireRoles(messages, classifications, undefined);
  assert.equal(classifications[1]?.wireRole, undefined);

  attachWireRoles(messages, classifications, [{ role: "assistant", content: "unrelated" }]);
  assert.equal(classifications[1]?.wireRole, undefined);
});

test("normalizeMessageText 覆盖字符串 / 内容块数组 / 未知结构，并去除前导空白", () => {
  assert.equal(normalizeMessageText("  hello"), "hello");
  assert.equal(
    normalizeMessageText([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "ab",
  );
  assert.equal(normalizeMessageText([{ type: "image", source: {} }]), "");
  assert.equal(normalizeMessageText({ weird: true }), "");
});
