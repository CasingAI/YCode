/**
 * 「供应商和模型」详情区视图状态判定（docs/specs/model-provider-empty-state.md）。
 *
 * 预置品牌入口下线后，零供应商环境没有任何默认选中项；历史上「未选中 → 加载卡片」
 * 的兜底会被永久触达，表现为假加载。这里把「未选中且数据已就绪且没有条目」显式
 * 判定为空状态，与真实加载态区分。
 */
export type ModelProviderDetailViewState = "loading" | "empty" | "provider";

export function resolveModelProviderDetailViewState(input: {
  /** 是否存在选中导航项。 */
  hasSelection: boolean;
  /** 数据加载/刷新中（presetLoading = loading || refreshing）。 */
  presetLoading: boolean;
  /** 导航条目数；null 表示调用方未提供导航数据（此时无法判定空状态，回落加载态）。 */
  navigationItemCount: number | null;
}): ModelProviderDetailViewState {
  if (input.hasSelection) {
    return "provider";
  }
  if (!input.presetLoading && input.navigationItemCount === 0) {
    return "empty";
  }
  return "loading";
}
