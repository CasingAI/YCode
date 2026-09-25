import type { ModelId } from "./config/index.js";

/**
 * 墓碑只让内置声明失效，不占用模型 ID。
 *
 * 成员解析的最早一步先让内置名单减去墓碑，此后去重、排序、来源判定、配置解析、
 * Settings View 和 Registry 拿到的都是过滤后的最终名单，上层无需感知删除状态。
 * 个人模型不参与这一步，因此用户删除过的 ID 之后仍然可以手动添加。
 *
 * 注意：过滤只发生在解析产出的模型名单上。ProviderConfig 里的
 * builtinModelIds/personalModelIds/modelOrder 与 excludedModelIds 本身保持原样，
 * 设置视图回显的 effectiveConfig/personalConfig 因此仍是未过滤的完整配置。
 * 判断"这个 Provider 有哪些模型"必须使用解析后的 provider.models，
 * 不要直接遍历 config.builtinModelIds。
 */
export function excludeDeletedModelIds(
  modelIds: readonly ModelId[] | null | undefined,
  excludedModelIds: readonly ModelId[] | null | undefined,
): readonly ModelId[] {
  if (!excludedModelIds?.length) return modelIds ?? [];
  const excluded = new Set(excludedModelIds);
  return (modelIds ?? []).filter((modelId) => !excluded.has(modelId));
}
