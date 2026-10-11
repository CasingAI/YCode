import type { ModelSelection } from "@zcode/shared/model-selection";
import { normalizeThoughtLevelText } from "@/chat-input-toolbar/thoughtLevelLabelIds.js";

/** 解析搜索档位所需的最小目录结构：只需要各模型的档位表。 */
export interface AiSearchReasoningCatalog {
  readonly providers: readonly {
    readonly providerId: string;
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly optionSpecs: { readonly reasoningLevel: { readonly values: readonly string[] } };
      };
    }[];
  }[];
}

// 关闭语义值与 thoughtLevelOptions.ts 的 NO_THOUGHT_LEVEL_VALUES 同表；那份住在
// 拖 provider 图标资源的模块里，这里按同一张表自声明，保持本模块无依赖、node --test 可直接跑。
const AI_SEARCH_NO_THINK_VALUES = new Set([
  "disabled",
  "false",
  "no",
  "none",
  "nothink",
  "no-think",
  "no_think",
  "off",
]);

/**
 * AI 搜索统一压到最低成本档位（docs/specs/command-center-ai-history-search.md）。
 * 模型身份（provider/model）不动，只改思考档位：档位表含关闭语义值时用关闭值
 * （取档位表顺序里的第一个，写回配置原值），否则用档位表第一项（配置声明顺序为低→高）。
 * 目录里找不到该模型或档位表为空时原样返回，不凭空编档位。
 */
export function resolveAiSearchModelSelection(
  catalog: AiSearchReasoningCatalog,
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  if (!selection) return null;
  const values =
    catalog.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((model) => model.modelId === selection.modelId)?.config.optionSpecs
      .reasoningLevel.values ?? [];
  if (values.length === 0) return selection;
  const cheapest =
    values.find((value) => AI_SEARCH_NO_THINK_VALUES.has(normalizeThoughtLevelText(value))) ??
    values[0]!;
  if (selection.options?.reasoningLevel === cheapest) return selection;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: { reasoningLevel: cheapest },
  };
}
