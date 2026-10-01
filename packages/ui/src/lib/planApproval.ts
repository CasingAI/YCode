// 计划批准判定的 UI 入口。实现下沉到 shared：CLI 派生 sessions-index 摘要时
// 必须做同一套判定，两边各留一份字面量迟早漂移成「UI 认得出、列表摘要认不出」。
export {
  isPlanApprovalPendingSummary,
  isPlanApprovalUserInputRequest,
  type PlanApprovalPendingSummaryLike,
} from "@zcode/shared/zcode-protocol-v4";
