import type { UserInputRequestPayload } from "@zcode/shared/zcode-protocol-v4";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExitPlanModeToolName(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "exitplanmode";
}

/**
 * 计划批准交互（`ExitPlanMode` 的 `plan_approval`）的唯一判定实现。
 *
 * 它是 elicitation/userInput 而不是 permission，且必须同时按 `toolName` 与 `schema` 两个
 * 信号识别：旧快照与恢复链路只保留其中一个。弹窗层（静默拒绝）与通知编排（文案选型）
 * 都必须走这里，避免两处判定漂移出「一个拒绝、一个仍当普通问答」的分歧。
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
