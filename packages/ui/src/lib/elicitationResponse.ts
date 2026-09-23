import type { ZCodeElicitationQuestion } from "@zcode/shared";

// AskUserQuestion 的答案判定：草稿 → 提交内容、「跳过」如何改草稿、这次响应算 accept 还是 decline。
// 组件只负责渲染与焦点，规则集中在这里以便直接测（测试基建不渲染 React）。

export interface ElicitationAnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export type ElicitationDrafts = Record<string, ElicitationAnswerDraft>;

/** 归一化后的题目：key 是草稿的稳定主键，与题目文案解耦。 */
export interface NormalizedElicitationQuestion extends ZCodeElicitationQuestion {
  key: string;
}

export type ElicitationRespondAction = "accept" | "decline";

export interface ElicitationFooterAction {
  labelId: "chat.elicitation.skip" | "chat.elicitation.dismiss";
  kind: "skip" | "dismiss";
}

export function createEmptyElicitationAnswerDraft(): ElicitationAnswerDraft {
  return { selectedValues: [], customAnswer: "" };
}

export function getElicitationQuestionAnswers(
  question: NormalizedElicitationQuestion,
  drafts: ElicitationDrafts,
): string[] {
  const draft = drafts[question.key] ?? createEmptyElicitationAnswerDraft();
  const customAnswer = draft.customAnswer.trim();
  return [...draft.selectedValues, ...(customAnswer ? [customAnswer] : [])];
}

export function hasElicitationAnswer(
  questions: readonly NormalizedElicitationQuestion[],
  drafts: ElicitationDrafts,
): boolean {
  return questions.some((question) => getElicitationQuestionAnswers(question, drafts).length > 0);
}

/**
 * 「跳过」= 拒绝当前这一题：整条草稿移除（已选项与自定义文本一起丢），
 * 构建 answers 时这题自然缺席，模型侧看到的就是 skipped，其余题不受影响。
 */
export function clearElicitationQuestionDraft(
  drafts: ElicitationDrafts,
  questionKey: string,
): ElicitationDrafts {
  const next = { ...drafts };
  delete next[questionKey];
  return next;
}

export function buildElicitationResponseContent(
  questions: readonly NormalizedElicitationQuestion[],
  drafts: ElicitationDrafts,
): Record<string, unknown> {
  // AskUserQuestion 是可选澄清，不是必填表单。只提交用户真实提供的答案，
  // 避免用空字符串伪造偏好；被跳过的题缺席，由 Agent 按 skipped 处理。
  const answers = Object.fromEntries(
    questions.flatMap((question) => {
      const questionAnswers = getElicitationQuestionAnswers(question, drafts);
      return questionAnswers.length > 0 ? [[question.question, questionAnswers.join(", ")]] : [];
    }),
  );
  const content: Record<string, unknown> = { answers };

  questions.forEach((question, index) => {
    const questionAnswers = getElicitationQuestionAnswers(question, drafts);
    if (questionAnswers.length > 0) {
      content[`answer_${index}`] = question.multiSelect ? questionAnswers : questionAnswers[0];
    }
  });

  // 兼容旧版单题 agent 读取 { answer } 的路径。
  const onlyQuestion = questions.length === 1 ? questions[0] : undefined;
  if (onlyQuestion) {
    const questionAnswers = getElicitationQuestionAnswers(onlyQuestion, drafts);
    if (questionAnswers.length > 0) {
      content.answer = onlyQuestion.multiSelect ? questionAnswers : questionAnswers[0];
    }
  }

  return content;
}

export function getElicitationQuestionAdvanceKind(
  questions: readonly NormalizedElicitationQuestion[],
  questionIndex: number,
): "next" | "submit" {
  return questionIndex >= questions.length - 1 ? "submit" : "next";
}

/**
 * 一题都没答（逐题跳过到最后一题，或一路翻页没填）等于整组拒绝：发 decline，
 * 模型收到 declined，而不是「用户没回答，请自行判断」。
 * 计划审批不适用：它的批准/拒绝由 content 表达，空答案在审批协议里本身就是拒绝。
 */
export function resolveElicitationRespondAction(options: {
  isPlanApproval: boolean;
  questions: readonly NormalizedElicitationQuestion[];
  drafts: ElicitationDrafts;
}): ElicitationRespondAction {
  if (options.isPlanApproval) return "accept";
  return hasElicitationAnswer(options.questions, options.drafts) ? "accept" : "decline";
}

/**
 * 底部左侧按钮：计划审批复用本对话框，但空答案在审批协议里表示拒绝，
 * 所以那里仍是「忽略」= 拒绝计划；只有普通问答是「跳过」——指的是这一题不答。
 */
export function resolveElicitationFooterAction(isPlanApproval: boolean): ElicitationFooterAction {
  return isPlanApproval
    ? { labelId: "chat.elicitation.dismiss", kind: "dismiss" }
    : { labelId: "chat.elicitation.skip", kind: "skip" };
}
