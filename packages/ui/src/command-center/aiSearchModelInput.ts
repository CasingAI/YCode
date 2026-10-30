import type { ModelGroupIntent, ModelSelection } from "@zcode/shared/model-selection";
import type { ComposerDisplayedModel } from "@/lib/composerDisplayedModel.js";
import type { ComposerRecent } from "@/lib/composerRecent.js";

/**
 * 命令中心 AI 搜索的模型意图（docs/specs/composer-displayed-model.md）：
 * 工作区“最后展示的模型意图”整体优先，缺失/坏数据时退最近一次 accepted 发送偏好。
 * 两种来源都可能是具体选择或组意图；组意图只原样下发，不在 UI 展开成员。
 */
export type AiSearchModelInput =
  | { readonly selection: ModelSelection }
  | { readonly modelGroupIntent: ModelGroupIntent };

/**
 * displayed 整体优先于 recent：displayed 的组意图也优先于 recent 的具体模型，
 * 因为组是前台当前展示事实，recent 只是上一次发送偏好。displayed 缺失时才用 recent。
 */
export function resolveAiSearchModelInput(
  displayed: ComposerDisplayedModel | null | undefined,
  recent: ComposerRecent | null | undefined,
): AiSearchModelInput | undefined {
  if (displayed) {
    if ("selection" in displayed) return { selection: displayed.selection };
    if ("modelGroupIntent" in displayed) return { modelGroupIntent: displayed.modelGroupIntent };
  }
  if (recent?.modelSelection) return { selection: recent.modelSelection };
  if (recent?.modelGroupIntent) return { modelGroupIntent: recent.modelGroupIntent };
  return undefined;
}
