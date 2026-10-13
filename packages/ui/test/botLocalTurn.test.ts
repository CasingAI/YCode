import assert from "node:assert/strict";
import test from "node:test";
import { latestPendingAsk, planBotLocalTurn } from "../src/bots/botLocalTurn.js";

test("问句走带按钮询问", () => {
  const turn = planBotLocalTurn({ text: "要不要开任务？", intlYes: "好", intlNo: "先不用" });
  assert.equal(turn.kind, "ask");
  if (turn.kind === "ask") {
    assert.equal(turn.choices.length, 2);
  }
});

test("进度类走工人", () => {
  const turn = planBotLocalTurn({ text: "帮我盯一下进度", intlYes: "y", intlNo: "n" });
  assert.equal(turn.kind, "worker");
});

test("普通句子走短消息", () => {
  const turn = planBotLocalTurn({ text: "你好", intlYes: "y", intlNo: "n" });
  assert.equal(turn.kind, "message");
});

test("最新未回答询问可被找到", () => {
  const pending = latestPendingAsk([
    { id: "1", kind: "ask", text: "old", createdAt: 1, ask: { choices: [], selectedId: "yes" } },
    { id: "2", kind: "ask", text: "new", createdAt: 2, ask: { choices: [] } },
  ]);
  assert.equal(pending?.id, "2");
});
