// 计划批准（`ExitPlanMode` 的 `plan_approval`）的跨端判定。
//
// 放在 shared 而不是 UI：CLI 侧派生 sessions-index 摘要时必须做同一套判定
// （决定 pendingInteraction 优先返回哪一条），两边各写一份字面量迟早漂移成
// 「UI 认得出、列表摘要认不出」的分裂。本包纪律：只放纯函数。
import type { UserInputRequestPayload } from "./snapshot.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExitPlanModeToolName(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "exitplanmode";
}

/**
 * 行级判定：这行工具是不是计划批准的载体（`ExitPlanMode`）。
 *
 * v4→legacy 桥接层用它识别“计划批准拒绝”：该拒绝是预期的搁置终态，
 * 不得被贴上失败标记。口径与 `isPlanApprovalUserInputRequest` 内的工具名
 * 判定同一份，不得在消费方另写字面量。
 */
export function isPlanApprovalToolName(value: unknown): boolean {
  return isExitPlanModeToolName(value);
}

/**
 * 计划批准交互（`ExitPlanMode` 的 `plan_approval`）在**完整 payload** 下的唯一判定实现。
 *
 * 它是 elicitation/userInput 而不是 permission，且必须同时按 `toolName` 与 `schema` 两个
 * 信号识别：旧快照与恢复链路只保留其中一个。弹窗层（静默拒绝）、通知编排（文案选型）
 * 与 sessions-index 摘要派生都必须走这里。
 */
export function isPlanApprovalUserInputRequest(payload: UserInputRequestPayload): boolean {
  if (isExitPlanModeToolName(payload.toolName)) {
    return true;
  }
  if (!isPlainRecord(payload.schema)) {
    return false;
  }
  return (
    payload.schema.interaction === "plan_approval" ||
    isExitPlanModeToolName(payload.schema.toolName)
  );
}

/** sessions-index 摘要里的待结算项（只有 kind 与 toolName，没有 schema 与 questions）。 */
export interface PlanApprovalPendingSummaryLike {
  kind: "permission" | "userInput";
  toolName?: string;
}

/**
 * 计划批准在 **sessions-index 摘要** 形态下的判定。
 *
 * 摘要没有 schema，只带 toolName，因此只能用工具名这一个信号——这正是
 * `createPendingInteractionFromPermissionEvent` 在 ExitPlanMode 分支里必定写入
 * `toolName` 的原因。
 */
export function isPlanApprovalPendingSummary(
  summary: PlanApprovalPendingSummaryLike | null | undefined,
): boolean {
  return (
    Boolean(summary) && summary?.kind === "userInput" && isExitPlanModeToolName(summary.toolName)
  );
}
