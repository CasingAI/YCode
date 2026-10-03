import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts, MessagePart } from "@zcode/contracts";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";

// 失败 assistant 消息不进 provider 历史（spec session-error-banner-continue.md §4.3）。
// 这是「模型感知不到发生过网络问题」的前提：live 路径的 recoverFromModelFailure 会丢弃
// 失败那一步的输出后重发同一请求，冷恢复必须给出同一份上下文 —— 否则模型会看到「上次说到
// 一半就断了」，同 turn 续跑重放的前缀也不再等于失败前那次。

function textPart(id: string, messageID: string, text: string): MessagePart {
  return { id, sessionID: "sess-1", messageID, type: "text", text } as MessagePart;
}

function userMessage(id: string, text: string): MessageWithParts {
  return {
    info: { id, sessionID: "sess-1", role: "user", time: { created: 1 } },
    parts: [textPart(`${id}_p`, id, text)],
  } as unknown as MessageWithParts;
}

function assistantMessage(input: {
  id: string;
  parentID: string;
  text: string;
  error?: string;
}): MessageWithParts {
  return {
    info: {
      id: input.id,
      sessionID: "sess-1",
      role: "assistant",
      time: { created: 2 },
      parentID: input.parentID,
      ...(input.error ? { error: { name: "UnknownError", data: { message: input.error } } } : {}),
    },
    parts: [textPart(`${input.id}_p`, input.id, input.text)],
  } as unknown as MessageWithParts;
}

async function providerTexts(messages: MessageWithParts[]): Promise<string[]> {
  const history = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({ history, messages });
  return history
    .borrowReadOnlyRuntimeEntries()
    .filter((entry) => entry.kind !== "attachment")
    .map((entry) => (entry.kind === "attachment" ? "" : JSON.stringify(entry.message)));
}

test("带 error 的 assistant 消息不灌进 provider 历史（含流式中断的半截正文）", async () => {
  const texts = await providerTexts([
    userMessage("msg_u1", "原始问题"),
    assistantMessage({ id: "msg_a1", parentID: "msg_u1", text: "", error: "rate limited" }),
  ]);

  assert.equal(texts.length, 1, "失败那一步不能进历史");
  assert.match(texts[0] ?? "", /原始问题/);
});

test("没有 error 的 assistant 消息照常灌入（正常轮次不受影响）", async () => {
  const texts = await providerTexts([
    userMessage("msg_u1", "原始问题"),
    assistantMessage({ id: "msg_a1", parentID: "msg_u1", text: "回答" }),
  ]);

  assert.equal(texts.length, 2);
  assert.match(texts[1] ?? "", /回答/);
});

test("失败轮被丢弃后，上下文与「那次请求从未发出」逐字相同", async () => {
  const interrupted = await providerTexts([
    userMessage("msg_u1", "原始问题"),
    assistantMessage({ id: "msg_a1", parentID: "msg_u1", text: "说到一半", error: "socket hang up" }),
  ]);
  const neverStarted = await providerTexts([userMessage("msg_u1", "原始问题")]);

  assert.deepEqual(interrupted, neverStarted);
});