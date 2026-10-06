// 计划工具（`CreatePlan` 与历史 `ExitPlanMode`）的跨端判定。
//
// 放在 shared 而不是 UI：fork 继承、计划目录、行过滤等多处都要判断“这一行是不是计划工具”，
// 两边各写一份字面量迟早漂移成「UI 认得出、列表摘要认不出」的分裂。本包纪律：只放纯函数。
// 兼容只认工具名，不认形状：V1 官方原版与 V2 改版 ExitPlanMode 对兼容层是同一个东西，不做版本分支。

/**
 * 行级判定：这行工具是不是计划工具（`CreatePlan` 或历史 `ExitPlanMode`，大小写不敏感）。
 *
 * v4→legacy 桥接层用它识别历史“计划批准拒绝”：该拒绝是预期的搁置终态，
 * 不得被贴上失败标记。消费方不得另写字面量。
 */
export function isPlanApprovalToolName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "createplan" || normalized === "exitplanmode";
}

/** 历史 `EnterPlanMode` 行过滤的共享判据：行过滤器改走这里，不写字面量。 */
export function isEnterPlanModeToolName(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "enterplanmode";
}
