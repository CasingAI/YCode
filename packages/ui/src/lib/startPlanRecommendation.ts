import type { ModelSelectionView } from "@zcode/provider";
import type { ModelSelection, UsageEntitlementSnapshot } from "@zcode/shared";

// 智谱剥离：Start Plan 推荐链路已下线，一律不推荐（见 docs/specs/zhipu-special-removal.md）。
/** 只消费目标 Registry 与已有额度事实；未知额度跳过，不为提交增加查询门禁。 */
export function resolveStartPlanRecommendation(
  _selection: ModelSelection,
  _view: ModelSelectionView | null | undefined,
  _snapshot: UsageEntitlementSnapshot | null,
): ModelSelection | null {
  return null;
}

/** 只改思考档位、继承或其他字段不属于模型更换。 */
export function hasExplicitModelChanged(
  previous: ModelSelection | null | undefined,
  next: ModelSelection | null | undefined,
): next is ModelSelection {
  return Boolean(
    next && (previous?.providerId !== next.providerId || previous.modelId !== next.modelId),
  );
}
