import assert from "node:assert/strict";
import test from "node:test";
import type { GoalState } from "@zcode/shared/zcode-protocol-v4";
import {
  getConversationGoalElapsedSeconds,
  getConversationGoalPanelTitle,
} from "../src/v4/conversationGoalSummaryModel.js";

function goalState(input: {
  summaryTitle?: string;
  objective?: string;
  status?: GoalState["status"];
  timeUsedSeconds?: number;
  activeRunStartedAtMs?: number | null;
}): GoalState {
  return {
    iteration: 1,
    status: input.status ?? "active",
    summaryTitle: input.summaryTitle ?? null,
    objective: input.objective ?? "修复登录",
    timeUsedSeconds: input.timeUsedSeconds ?? 0,
    activeRunStartedAtMs: input.activeRunStartedAtMs ?? null,
    iterations: [],
    verifications: [],
  } as unknown as GoalState;
}

test("面板目标标题优先取摘要标题", () => {
  const goal = goalState({ summaryTitle: "  修复登录流程  ", objective: "更长的原始目标" });
  assert.equal(getConversationGoalPanelTitle(goal), "修复登录流程");
});

test("面板目标标题在摘要缺失或空白时回退目标原文", () => {
  assert.equal(
    getConversationGoalPanelTitle(goalState({ objective: "  修复登录  " })),
    "修复登录",
  );
  assert.equal(getConversationGoalPanelTitle(goalState({ summaryTitle: "   " })), "修复登录");
});

test("面板目标标题在摘要与原文都空白时返回 null", () => {
  assert.equal(getConversationGoalPanelTitle(goalState({ objective: "   " })), null);
});

test("面板耗时在非运行状态只计累计秒数", () => {
  const goal = goalState({ status: "paused", timeUsedSeconds: 65, activeRunStartedAtMs: null });
  assert.equal(getConversationGoalElapsedSeconds(goal, 1_000_000), 65);
});

test("面板耗时在运行中叠加本轮已跑时间", () => {
  const goal = goalState({ status: "active", timeUsedSeconds: 30, activeRunStartedAtMs: 1_000 });
  assert.equal(getConversationGoalElapsedSeconds(goal, 61_000), 90);
});
