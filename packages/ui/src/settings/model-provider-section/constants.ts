import { createUuid, type UsageEntitlementSnapshot } from "@zcode/shared";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

export function generateId(): string {
  return createUuid();
}

// 智谱剥离：account:* 套餐身份、预置品牌入口、Team/Start 独立分支已下线
//（见 docs/specs/zhipu-special-removal.md）。导航只保留 custom/personal 两类，
// 模板新建的智谱 provider 与普通 custom 走同一条展示与删除路径。

export type CodingPlanStatus =
  | "disconnected"
  | "checking"
  | "notPurchased"
  | "purchased"
  | "unavailable"
  | "unsupported";

export interface CodingPlanEntitlementState {
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

export function resolveModelProviderDisplayName(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "config">,
): string {
  return getProviderFormLabel(provider);
}

export type ModelProviderNavItem =
  | {
      key: string;
      type: "custom";
      label: string;
      provider: ProviderSettingsFormProvider;
      statusActive: boolean;
    };

export type ModelProviderNavGroupId = "opencode" | "cliproxy" | "custom";

export interface ModelProviderNavGroup {
  id: ModelProviderNavGroupId;
  title: string;
  items: ModelProviderNavItem[];
}
