import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";

/**
 * 草稿展示用的有效选择（docs/specs/composer-model-switch-continuity.md）。
 * 只认已经对应本次草稿选择的 View：切换模型的瞬间目录仍可复用，但其中的结果对应上一次选择，
 * 这时回落到草稿意图，让胶囊当帧就能按目标模型出展示名；解析完成后仍以 View 的结果为准。
 */
export function resolveDraftEffectiveSelection(params: {
  selectionFresh: boolean;
  view: ModelSelectionView | null;
  intent: ModelSelection | undefined;
}): ModelSelection | undefined {
  const { selectionFresh, view, intent } = params;
  if (!selectionFresh || !view) return intent;
  // 已解析但结果缺失（selectionIssue）不等于没读过：保持空值，不拿意图冒充生效选择。
  return view.effectiveSelection ?? undefined;
}
