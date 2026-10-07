import type { GoalState } from "@zcode/shared/zcode-protocol-v4";

/**
 * 状态面板目标区的单行标题：摘要标题优先，回退目标原文。
 * 轮次历史不在面板展示（见 docs/specs/goal-status-panel-single-objective.md）。
 */
export function getConversationGoalPanelTitle(goal: GoalState): string | null {
  const title = goal.summaryTitle?.trim() || goal.objective.trim();
  return title.length > 0 ? title : null;
}

export function getConversationGoalElapsedSeconds(goal: GoalState, now: number): number {
  const baseSeconds = Math.max(0, Math.floor(goal.timeUsedSeconds ?? 0));
  const isRunning =
    goal.status === "active" || goal.status === "verifying" || goal.status === "notSatisfied";
  if (!isRunning || goal.activeRunStartedAtMs == null) return baseSeconds;
  return baseSeconds + Math.max(0, Math.floor((now - goal.activeRunStartedAtMs) / 1000));
}
