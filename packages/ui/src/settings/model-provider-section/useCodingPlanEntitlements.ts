import { useCallback } from "react";
import type { ProviderSettingsView } from "@zcode/services";
import type { ProviderFamilyConnectionSelectionSettings } from "@zcode/shared";
import type { UsageEntitlementRefreshOptions } from "@/hooks/useUsageEntitlement.js";
import type { CodingPlanEntitlementState } from "@/settings/model-provider-section/constants.js";

// 智谱剥离：套餐权益聚合已下线（见 docs/specs/zhipu-special-removal.md）。
// hook 保留签名兼容旧调用方，一律返回空，不再发起权益查询。
export function useCodingPlanAccessRefresh(_params: {
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
  selectedPlanKey: string | null;
}): void {}

export function useCodingPlanEntitlements(_params: {
  providerSettingsView: ProviderSettingsView | null;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  suppressProviderFingerprintAutoRefresh?: boolean;
}): {
  entitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  enabledStartPlanProviderIds: string[];
  accountFingerprint: string;
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
} {
  const refresh = useCallback(async (_options: UsageEntitlementRefreshOptions = {}) => {}, []);
  return {
    entitlements: {},
    enabledStartPlanProviderIds: [],
    accountFingerprint: "",
    refresh,
  };
}
