import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { formatModelDisplayName } from "@/lib/modelDisplayName.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";

interface V4ModelTriggerDisplay {
  fullLabel: string;
  modelLabel: string;
  providerPrefix?: string;
}

// 智谱剥离：套餐身份后缀（Coding/Start/Team Plan）已删除，切换记录只显示模型名
//（见 docs/specs/zhipu-special-removal.md）。保留函数签名兼容调用方。
export function formatModelChangeLabel(
  _providerId: string | undefined,
  _providerName: string | undefined,
  modelName: string,
  _intl: Pick<IntlInstance, "formatMessage">,
): string {
  return modelName;
}

export function formatProviderModelLabel(
  _providerId: string | undefined,
  providerName: string | undefined,
  modelName: string,
): string {
  const normalizedProviderName = providerName?.trim();
  return normalizedProviderName ? `${normalizedProviderName}/${modelName}` : modelName;
}

export function resolveV4ModelTriggerLabel({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): string {
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  if (!selectedGroup || !selectedItem) {
    return fallbackLabel;
  }

  return formatProviderModelLabel(providerId, providerName, selectedItem.name);
}

export function resolveV4ModelTriggerDisplay({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): V4ModelTriggerDisplay {
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  if (!selectedGroup || !selectedItem) {
    return { fullLabel: fallbackLabel, modelLabel: fallbackLabel };
  }

  const modelLabel = formatModelDisplayName(selectedItem.name);
  const normalizedProviderName = providerName?.trim();
  if (!normalizedProviderName) {
    return { fullLabel: modelLabel, modelLabel };
  }

  const providerPrefix = `${normalizedProviderName}/`;
  return {
    fullLabel: `${providerPrefix}${modelLabel}`,
    providerPrefix,
    modelLabel,
  };
}
