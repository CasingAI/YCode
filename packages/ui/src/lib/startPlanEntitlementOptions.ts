import type { ProviderSettingsView } from "@zcode/services";
import { resolveModelProviderFamilySpecByProviderId } from "@zcode/shared";
import type { UseUsageEntitlementOptions } from "@/hooks/useUsageEntitlement.js";
import {
  resolveAccountProviderInspectionAccess,
  resolveAccountProviderInspectionFingerprint,
} from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";

/** 设置、输入框与提交推荐复用原权益缓存；账号身份由 Account Source 的连接指纹提供。 */
export function buildStartPlanEntitlementOptions(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): UseUsageEntitlementOptions {
  const inspection = resolveAccountProviderInspectionAccess(view, providerId);
  const family = resolveModelProviderFamilySpecByProviderId(providerId);
  const fingerprint = resolveAccountProviderInspectionFingerprint(view, providerId);
  return {
    enabled: Boolean(inspection && family),
    preferredProviderId: providerId,
    accountAccess: family
      ? { type: "zhipu-account", family: family.id, planKind: "start-plan" }
      : undefined,
    includeSubscription: true,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({ providerId, providerFingerprint: fingerprint }),
    refreshOnMount: false,
  };
}
