import type { ProviderSettingsView } from "@zcode/services";
import type { UseUsageEntitlementOptions } from "@/hooks/useUsageEntitlement.js";

/** 智谱剥离：Start Plan 账号权益链路已下线，一律禁用查询（见 docs/specs/zhipu-special-removal.md）。 */
export function buildStartPlanEntitlementOptions(
  _view: ProviderSettingsView | null | undefined,
  providerId: string,
): UseUsageEntitlementOptions {
  return {
    enabled: false,
    preferredProviderId: providerId,
    includeSubscription: true,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    refreshOnMount: false,
  };
}
