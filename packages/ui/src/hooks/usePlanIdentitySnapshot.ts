import { useCallback } from "react";
import {
  normalizeProviderFamilyDomain,
  resolvePlanIdentitySnapshot,
  type PlanIdentitySnapshot,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import { USAGE_ENTITLEMENT_CACHE_TTL_MS } from "@/lib/usageEntitlementCache.js";

// 智谱剥离：套餐身份快照链路已下线（见 docs/specs/zhipu-special-removal.md）。
// hook 保留签名兼容调用方，一律返回 unknown，不再发起权益查询。
export function usePlanIdentitySnapshot(
  providerFamilyDomain: ProviderFamilyDomain | null | undefined,
  _connectionSelection: ProviderFamilyConnectionSelection | null | undefined,
  _usageStatsService?: IUsageStatsService,
): () => PlanIdentitySnapshot {
  const normalizedDomain = normalizeProviderFamilyDomain(providerFamilyDomain);

  return useCallback(
    () =>
      resolvePlanIdentitySnapshot({
        providerFamilyDomain: normalizedDomain,
        codingPlanEntitlement: null,
        startPlanEntitlement: null,
        now: Date.now(),
        entitlementCacheTtlMs: USAGE_ENTITLEMENT_CACHE_TTL_MS,
      }),
    [normalizedDomain],
  );
}
