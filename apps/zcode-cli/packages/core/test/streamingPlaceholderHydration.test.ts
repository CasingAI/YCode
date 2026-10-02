import assert from "node:assert/strict";
import test from "node:test";
import type { MessagePart, MessageWithParts, SessionId } from "@zcode/contracts";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";

// 流中占位保序（streaming-pipelined-tool-execution spec）在模型步起点写空 reasoning /
// 空 text part 占住 sequence，Stop / 断流等提前退出路径不回填它们。冷恢复把这些
// transcript part 还原成 provider history 时必须跳过空占位，判据与直播路径的
// hasAssistantReasoningContent 同款：否则会把 `{ type: "reasoning", text: "" }` 当成真实
// 思考发给 provider，并给正文前面拼出一段空行。

const SESSION_ID = "session-placeholder" as SessionId;
const MESSAGE_ID = "message-placeholder" as MessageWithParts["info"]["id"];
const BASE_TIME = 1_700_000_000_000;

function part(id: string, input: Record<string, unknown>): MessagePart {
  return {
    id,
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    ...input,
  } as unknown as MessagePart;
}

function assistantMessage(parts: MessagePart[]): MessageWithParts {
  return {
    info: {
      id: MESSAGE_ID,
      role: "assistant",
      sessionID: SESSION_ID,
      time: { created: BASE_TIME, completed: BASE_TIME + 100 },
    },
    parts,
  } as unknown as MessageWithParts;
}

function hydrate(parts: MessagePart[]) {
  const history = new MessageHistoryImpl();
  history.init("system");
  return hydrateMessageHistoryFromSession({
    history,
    messages: [assistantMessage(parts)],
  }).then(() => history.toRuntimeEntries());
}

const emptyReasoning = () =>
  part("part-reasoning-placeholder", { type: "reasoning", text: "", time: { start: BASE_TIME } });
const emptyText = () => part("part-text-placeholder", { type: "text", text: "" });
const realText = (text: string) => part("part-text-real", { type: "text", text });
const toolPart = () =>
  part("part-tool", {
    type: "tool",
    callID: "call-1",
    tool: "CreatePlan",
    state: {
      status: "completed",
      input: {},
      title: "CreatePlan",
      output: "计划已写入",
      time: { start: BASE_TIME },
    },
  });

test("空 reasoning 占位不进 provider 历史", async () => {
  const entries = await hydrate([emptyReasoning(), realText("计划写好了"), toolPart()]);

  const assistant = entries.find((entry) => entry.message.role === "assistant");
  assert.ok(assistant, "应产出一条 assistant 历史");
  const content = assistant.message.content;
  // 空占位被丢掉后，正文退回「无思考块」的形态：content 是纯字符串而不是 reasoning+text 数组。
  assert.equal(content, "计划写好了");
  assert.notEqual(
    Array.isArray(content) && content.some((block) => block.type === "reasoning"),
    true,
    "空 reasoning 占位不得进入 provider 历史",
  );
});

test("只有空占位与工具的轮次不产生空 reasoning 块", async () => {
  const entries = await hydrate([emptyReasoning(), emptyText(), toolPart()]);

  const assistant = entries.find((entry) => entry.message.role === "assistant");
  assert.ok(assistant, "工具轮次仍应进入 provider 历史");
  assert.equal(assistant.message.content, "", "正文为空时 content 保持空串");
  assert.equal(assistant.message.toolCalls?.length, 1);
});

test("Stop 路径的空 text 占位不给真实正文拼出前导空行", async () => {
  const entries = await hydrate([
    emptyReasoning(),
    emptyText(),
    part("part-text-after-stop", { type: "text", text: "计划写好了" }),
  ]);

  const assistant = entries.find((entry) => entry.message.role === "assistant");
  assert.ok(assistant, "应产出一条 assistant 历史");
  assert.equal(assistant.message.content, "计划写好了", "空占位不得污染正文");
});
