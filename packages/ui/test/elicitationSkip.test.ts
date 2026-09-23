import assert from "node:assert/strict";
import test from "node:test";
import {
  buildElicitationResponseContent,
  clearElicitationQuestionDraft,
  getElicitationQuestionAdvanceKind,
  resolveElicitationFooterAction,
  resolveElicitationRespondAction,
  type ElicitationDrafts,
  type NormalizedElicitationQuestion,
} from "../src/lib/elicitationResponse.js";

// 「跳过」的语义：拒绝当前这一题，其余题照常提交。这些判定决定模型收到什么，
// 一旦退回成「整组忽略 + 丢弃草稿」，用户填过的答案就会再次消失。

function question(key: string, text: string, multiSelect = false): NormalizedElicitationQuestion {
  return {
    key,
    question: text,
    header: text,
    multiSelect,
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  };
}

const QUESTIONS = [question("0:代理", "用哪个代理？"), question("1:证书", "证书怎么处理？")];

function draftsWithAnswer(answeredKey: string, value: string): ElicitationDrafts {
  return { [answeredKey]: { selectedValues: [value], customAnswer: "" } };
}

test("跳过只清掉当前这一题的草稿，其他题的答案不受影响", () => {
  const before: ElicitationDrafts = {
    "0:代理": { selectedValues: ["a"], customAnswer: "" },
    "1:证书": { selectedValues: [], customAnswer: "自签证书" },
  };

  const after = clearElicitationQuestionDraft(before, "0:代理");

  assert.equal("0:代理" in after, false);
  assert.deepEqual(after["1:证书"], { selectedValues: [], customAnswer: "自签证书" });
  // 原对象不可变，避免调用方拿到的旧草稿被顺手改掉。
  assert.deepEqual(before["0:代理"], { selectedValues: ["a"], customAnswer: "" });
});

test("非最后一题跳过只是翻页，最后一题跳过才会提交", () => {
  assert.equal(getElicitationQuestionAdvanceKind(QUESTIONS, 0), "next");
  assert.equal(getElicitationQuestionAdvanceKind(QUESTIONS, 1), "submit");
});

test("最后一题跳过：提交其余已答的题，被跳过的那题不出现在 answers 里", () => {
  const drafts = draftsWithAnswer("0:代理", "a");
  const skipped = clearElicitationQuestionDraft(drafts, "1:证书");

  const content = buildElicitationResponseContent(QUESTIONS, skipped);

  assert.deepEqual(content.answers, { "用哪个代理？": "a" });
  assert.equal(content.answer_0, "a");
  assert.equal("answer_1" in content, false);
});

test("跳过全部题等于整组拒绝：发 decline 而不是空 answers", () => {
  const skipped = clearElicitationQuestionDraft(
    draftsWithAnswer("0:代理", "a"),
    "0:代理",
  );

  assert.equal(
    resolveElicitationRespondAction({ isPlanApproval: false, questions: QUESTIONS, drafts: skipped }),
    "decline",
  );
  assert.equal(
    resolveElicitationRespondAction({
      isPlanApproval: false,
      questions: QUESTIONS,
      drafts: draftsWithAnswer("0:代理", "a"),
    }),
    "accept",
  );
});

test("计划审批不受问答跳过语义影响：仍是 accept，空答案由审批协议判为拒绝", () => {
  assert.equal(
    resolveElicitationRespondAction({ isPlanApproval: true, questions: QUESTIONS, drafts: {} }),
    "accept",
  );
});

test("三题流程：答一题、后两题逐题跳过，已答的那题照常提交给模型", () => {
  const threeQuestions = [...QUESTIONS, question("2:重试", "失败要重试吗？")];
  let drafts: ElicitationDrafts = draftsWithAnswer("0:代理", "a");

  drafts = clearElicitationQuestionDraft(drafts, "1:证书");
  drafts = clearElicitationQuestionDraft(drafts, "2:重试");

  assert.equal(
    resolveElicitationRespondAction({ isPlanApproval: false, questions: threeQuestions, drafts }),
    "accept",
  );
  assert.deepEqual(buildElicitationResponseContent(threeQuestions, drafts).answers, {
    "用哪个代理？": "a",
  });
});

test("底部左侧按钮按场景分叉：普通问答是「跳过」，计划审批还是「忽略」", () => {
  assert.deepEqual(resolveElicitationFooterAction(false), {
    labelId: "chat.elicitation.skip",
    kind: "skip",
  });
  assert.deepEqual(resolveElicitationFooterAction(true), {
    labelId: "chat.elicitation.dismiss",
    kind: "dismiss",
  });
});
