import { isCliProxyProviderTemplateId, isOpenCodeProviderTemplateId } from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import type { ModelProviderNavGroupId } from "@/settings/model-provider-section/constants.js";

/**
 * 用户从未拖动过分组（或存储里没有显式组序）时使用的默认组序，
 * 与分组功能上线前的固定展示顺序一致。
 */
export const NAV_GROUP_CANONICAL_ORDER: readonly ModelProviderNavGroupId[] = [
  "opencode",
  "cliproxy",
  "custom",
];

export function resolveProviderNavGroupId(
  provider: Pick<ProviderSettingsFormProvider, "templateId">,
): ModelProviderNavGroupId {
  if (isOpenCodeProviderTemplateId(provider.templateId)) return "opencode";
  if (isCliProxyProviderTemplateId(provider.templateId)) return "cliproxy";
  return "custom";
}

/**
 * 分组顺序是显式持久化偏好（ProviderSettingsView.providerGroupOrder）：
 * 按存储里的顺序取已知组，去重；存储为空或缺了某些组时按 canonical 顺序补齐。
 * 不从扁平 provider 顺序推导——那会把历史添加顺序误当成用户意图。
 */
export function resolveNavGroupDisplayOrder(params: {
  explicitGroupOrder?: readonly string[];
}): ModelProviderNavGroupId[] {
  const known = new Set<ModelProviderNavGroupId>(NAV_GROUP_CANONICAL_ORDER);
  const explicit: ModelProviderNavGroupId[] = [];
  for (const groupId of params.explicitGroupOrder ?? []) {
    if (
      known.has(groupId as ModelProviderNavGroupId) &&
      !explicit.includes(groupId as ModelProviderNavGroupId)
    ) {
      explicit.push(groupId as ModelProviderNavGroupId);
    }
  }
  return [
    ...explicit,
    ...NAV_GROUP_CANONICAL_ORDER.filter((groupId) => !explicit.includes(groupId)),
  ];
}

/**
 * 把分组拖拽结果落回扁平 providerIds：按新组序整块拼接，组内成员保持原展示顺序。
 * 归类是全量函数（非 opencode-/cliproxy- 模板都归 custom），拼接结果覆盖全部 provider。
 */
export function reorderProviderIdsByNavGroups(params: {
  providersInDisplayOrder: readonly ProviderSettingsFormProvider[];
  groupOrder: readonly ModelProviderNavGroupId[];
}): string[] {
  return params.groupOrder.flatMap((groupId) =>
    params.providersInDisplayOrder
      .filter((provider) => resolveProviderNavGroupId(provider) === groupId)
      .map((provider) => provider.providerId),
  );
}
