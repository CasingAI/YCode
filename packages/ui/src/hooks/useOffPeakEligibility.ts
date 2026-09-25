import { useEffect } from "react";
import type { AppSettings } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";
import { buildOffPeakEligibilityFreshnessKey } from "@/lib/offPeakEligibilityFreshnessKey.js";

/** 两个闲时入口共享初始化/连接/账号事实通知边界，不在组件中另存资格。 */
export function useOffPeakEligibility(
  settings: AppSettings | null | undefined,
  providerSettingsView: ProviderSettingsView | null,
): void {
  const { offPeakTaskService, codingPlanSubscriptionService } = useServices();
  const initialize = useOffPeakTaskStore((state) => state.initialize);
  const refresh = useOffPeakTaskStore((state) => state.refreshCodingPlanSupport);
  const freshnessKey = buildOffPeakEligibilityFreshnessKey({ settings, providerSettingsView });

  useEffect(() => {
    void initialize({ offPeakTaskService, codingPlanSubscriptionService });
  }, [initialize, offPeakTaskService, codingPlanSubscriptionService]);

  useEffect(() => {
    if (freshnessKey === undefined) return;
    // 键变化只是失效信号；账号就绪、失效、切 Team 都会改键，相同 key 的双入口通知由 Store 去重。
    void refresh(offPeakTaskService, freshnessKey);
  }, [freshnessKey, offPeakTaskService, refresh]);
}
