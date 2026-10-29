import type { ModelSelection } from "@zcode/shared/model-selection";

/**
 * 命令中心 AI 搜索的模型意图（docs/specs/composer-displayed-model.md）：
 * 优先工作区“最后展示的模型”，缺失/坏数据时退最近一次 accepted 发送偏好。
 * 组意图不是具体模型，不参与本输入；两者的解析与降级都交给既有模型服务视图。
 */
export function resolveAiSearchModelInput(
  displayedSelection: ModelSelection | null | undefined,
  recentSelection: ModelSelection | null | undefined,
): { selection: ModelSelection } | undefined {
  const selection = displayedSelection ?? recentSelection;
  return selection ? { selection } : undefined;
}
