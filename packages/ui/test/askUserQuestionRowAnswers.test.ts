import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  getAskUserQuestionAnswerText,
  normalizeAskUserQuestionInput,
  readAskUserQuestionAnswers,
} from "../src/lib/askUserQuestion.js";
import { toolCallRowToLegacyNode } from "../src/v4/toolCallRowAdapter.js";

// 用户填的答案只存在于权限改写后的入参里（v4 行 = 权限结算后的 input）。
// 这条链路横跨「投影把改写后的入参写回行」和「渲染层从 input.answers 读答案」，
// 断任何一段，收起态就会把用户明明填过的答案显示成「未提供回答」。

const QUESTIONS = [
  {
    question: "代理怎么配？",
    header: "Proxy",
    multiSelect: false,
    options: [{ value: "a", label: "本机代理" }],
  },
];
const ANSWERS = { "代理怎么配？": "先讲远期的想法：走本机 7890 代理。" };

function toolCallRow(overrides: Partial<ToolCallRow>): ToolCallRow {
  return {
    rowId: 1,
    kind: "toolCall",
    createdAt: 1_700_000_000_000,
    turnId: "turn-1",
    toolCallId: "call-1",
    toolName: "AskUserQuestion",
    status: "success",
    inputText: "",
    ...overrides,
  } as ToolCallRow;
}

test("行入参带答案时，收起态渲染用户填的答案", () => {
  const node = toolCallRowToLegacyNode(
    toolCallRow({ input: { questions: QUESTIONS, answers: ANSWERS } }),
  );

  const answers = readAskUserQuestionAnswers(node.toolCall);
  const data = normalizeAskUserQuestionInput(node.toolCall.input);
  assert.deepEqual(answers, ANSWERS);
  assert.equal(
    getAskUserQuestionAnswerText(data.questions[0]!, answers, "未提供回答"),
    "先讲远期的想法：走本机 7890 代理。",
  );
});

test("行入参没有答案（拒绝/未回答）时仍回退到「未提供回答」", () => {
  const node = toolCallRowToLegacyNode(toolCallRow({ input: { questions: QUESTIONS } }));

  const answers = readAskUserQuestionAnswers(node.toolCall);
  const data = normalizeAskUserQuestionInput(node.toolCall.input);
  assert.equal(answers, undefined);
  assert.equal(
    getAskUserQuestionAnswerText(data.questions[0]!, answers, "未提供回答"),
    "未提供回答",
  );
});
