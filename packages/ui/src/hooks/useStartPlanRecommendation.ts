import { useCallback } from "react";
import type { ModelSelectionView } from "@zcode/provider";
import type { ModelSelection } from "@zcode/shared";

// 智谱剥离：Start Plan 推荐链路已下线，hook 保留签名兼容调用方，原样返回选择
//（见 docs/specs/zhipu-special-removal.md）。调用方不得再依赖推荐弹窗做提交分流。
/** 推荐只编辑本次提交的选择；设置与额度仍由 App/Host 的原服务拥有。 */
export function useStartPlanRecommendation(
  _view: ModelSelectionView | null | undefined,
  _surface?: "subagent" | "command",
) {
  return useCallback(async (selection: ModelSelection): Promise<ModelSelection | null> => {
    return selection;
  }, []);
}
