import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts } from "@zcode/contracts";
import { resolveFailedTurn } from "../src/runtime/methods/turn-resume.js";

// 同 turn 续跑（spec session-error-banner-continue.md §4）：失败轮的身份只能从持久转录
// 反查得到 —— 投影给的 productTurnId（user messageId）与 core 的 runtime turnId
// （assistant 消息 anchor.turnId）是两套 ID，两个入口都必须认。定位不到就必须返回
// undefined，让 handler 明确拒绝，绝不静默。

function userMessage(id: string): MessageWithParts {
  return {
    info: { id, sessionID: "sess-1", role: "user", time: { created: 1 } },
    parts: [],
  } as unknown as MessageWithParts;
}

function assistantMessage(input: {
  id: string;
  parentID: string;
  turnId?: string;
  error?: boolean;
}): MessageWithParts {
  return {
    info: {
      id: input.id,
      sessionID: "sess-1",
      role: "assistant",
      time: { created: 2 },
      parentID: input.parentID,
      ...(input.error ? { error: { name: "UnknownError", data: { message: "boom" } } } : {}),
      ...(input.turnId ? { anchor: { turnId: input.turnId } } : {}),
    },
    parts: [],
  } as unknown as MessageWithParts;
}

test("按 user messageId 定位失败轮，返回 runtime turnId 与 userMessageId", () => {
  const messages = [
    userMessage("msg_user_1"),
    assistantMessage({ id: "msg_a1", parentID: "msg_user_1", turnId: "turn_a" }),
    assistantMessage({ id: "msg_a2", parentID: "msg_user_1", turnId: "turn_a", error: true }),
  ];

  const resolved = resolveFailedTurn(messages, "msg_user_1");
  assert.equal(resolved?.runtimeTurnId, "turn_a");
  assert.equal(resolved?.userMessageId, "msg_user_1");
});

test("按 runtime turnId（anchor）也能定位：投影传进来的是哪套 ID 都能用", () => {
  const messages = [
    userMessage("msg_user_1"),
    assistantMessage({ id: "msg_a2", parentID: "msg_user_1", turnId: "turn_a", error: true }),
  ];

  const resolved = resolveFailedTurn(messages, "turn_a");
  assert.equal(resolved?.runtimeTurnId, "turn_a");
  assert.equal(resolved?.userMessageId, "msg_user_1");
});

test("该轮没有失败记录 → undefined（handler 据此明确拒绝，不静默）", () => {
  const messages = [
    userMessage("msg_user_1"),
    // 成功轮：有 assistant 消息但没有 error。
    assistantMessage({ id: "msg_a1", parentID: "msg_user_1", turnId: "turn_a" }),
  ];
  assert.equal(resolveFailedTurn(messages, "msg_user_1"), undefined);
  assert.equal(resolveFailedTurn(messages, "turn_missing"), undefined);
});

test("失败 assistant 消息缺 anchor.turnId → 退回用户消息 id（跨进程稳定的轮身份）", () => {
  const messages = [
    userMessage("msg_user_1"),
    assistantMessage({ id: "msg_a2", parentID: "msg_user_1", error: true }),
  ];
  const resolved = resolveFailedTurn(messages, "msg_user_1");
  // 不能凭空造 turnId：投影要按同一个 id 找回 failed header，否则复活信号被丢弃。
  assert.equal(resolved?.runtimeTurnId, "msg_user_1");
  assert.equal(resolved?.userMessageId, "msg_user_1");
});

test("只认该轮自己的失败消息：更早的失败轮不会被后来这轮认领", () => {
  const messages = [
    userMessage("msg_user_1"),
    assistantMessage({ id: "msg_a1", parentID: "msg_user_1", turnId: "turn_a", error: true }),
    userMessage("msg_user_2"),
    assistantMessage({ id: "msg_a2", parentID: "msg_user_2", turnId: "turn_b" }),
  ];
  const resolved = resolveFailedTurn(messages, "msg_user_2");
  assert.equal(resolved, undefined, "第二轮没有失败记录，不能拿第一轮的失败复活它");
});