import { useCallback, useMemo } from "react";
import type { ProviderFamilyDomain } from "@zcode/shared";
import type { EnterpriseCodingPlanProductDisplay } from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";

// 智谱剥离：企业 Team 定价查询已下线（见 docs/specs/zhipu-special-removal.md）。
// hook 保留签名兼容旧调用方，一律返回空。
export function useEnterpriseCodingPlanProducts(_params: {
  enabled: boolean;
  authenticated: boolean;
  family?: ProviderFamilyDomain;
  staticOnly?: boolean;
}): {
  snapshot: { productList: EnterpriseCodingPlanProductDisplay[] } | null;
  loading: boolean;
  error: string | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
} {
  const refresh = useCallback(async (_options?: { force?: boolean }) => {}, []);
  return useMemo(
    () => ({ snapshot: null, loading: false, error: null, refresh }),
    [refresh],
  );
}
