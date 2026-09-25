import { useCallback, useEffect, useState } from "react";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { BUILTIN_MODEL_PROVIDER_IDS, type EnterpriseCodingPlanPricingProduct } from "@zcode/shared";
import { buildOwnedEntryPlanList } from "@/lib/codingPlanOwnedEntryPlans.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import { resolveCodingPlanEntryInventoryStatus } from "@/lib/codingPlanEntryInventoryState.js";
import { logger } from "@/logger.js";

export interface CodingPlanEntryInventory {
  entryPlanList: string;
  status: "loading" | "error" | "ready";
  retry: () => void;
}

export function useCodingPlanEntryPlanList(): CodingPlanEntryInventory {
  const { state, reload } = useProviderSettingsView();
  const providerSettingsView = state.status === "ready" ? state.view : null;
  const loading = state.status === "loading";
  const { credentialService, codingPlanSubscriptionService } = useServices();
  const user = useZCodeStore((state) => state.user);
  // 不传当前选中的团队上下文，四种 Start/个人连接分别使用已有权益缓存。
  const { accountFingerprint, entitlements, refresh } = useCodingPlanEntitlements({
    providerSettingsView,
    suppressProviderFingerprintAutoRefresh: true,
  });
  // 套餐身份只认账号事实。设置投影每保存一次就是一个新对象（revision +1），
  // 拿对象身份当判据会让改模型名、拨 Provider 开关这类纯配置变更也重查权益与
  // 团队套餐定价，并把入口按钮打成"正在查询套餐"。
  // view 未就绪时为空串（不查）；已就绪但没连账号时仍要保留非空 identity，
  // 否则首次企业套餐查询永不发生，usableTeams 恒 false 会把入口显示成"重试"。
  const identity = providerSettingsView ? `ready:${accountFingerprint}` : "";
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => {
    if (state.status === "error") reload();
    setGeneration((value) => value + 1);
  }, [state.status, reload]);
  const [teams, setTeams] = useState<{
    user: typeof user;
    identity: string;
    sources: { token: string | null; products: EnterpriseCodingPlanPricingProduct[] | null }[];
    generation: number;
  } | null>(null);
  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    // 团队订阅以 authenticated pricing 为准，不用静态商品目录推断已购套餐。
    void Promise.all([
      refresh({ force: true, silent: true }),
      Promise.all(
        (["bigmodel", "zai"] as const).map(async (family) => {
          let token: string | null = null;
          try {
            token = (await credentialService.load(`oauth:${family}:access_token`))?.trim() || null;
            if (!token) return { token, products: [] };
            const result = await codingPlanSubscriptionService.getEnterprisePricing({
              authenticated: true,
              family,
            });
            return { token, products: result.productList };
          } catch (error) {
            logger.warn("[purchaseTelemetry] 读取团队套餐失败", { family, error });
            return { token, products: null };
          }
        }),
      ),
    ]).then(([, sources]) => {
      if (!cancelled)
        setTeams((previous) => ({
          user,
          identity,
          generation,
          sources: sources.map((source, index) => {
            // 刷新失败不等于未购；仅在账号、family 和凭据一致时复用成功结果。
            const cached = previous?.sources[index];
            return source.products === null &&
              source.token &&
              previous?.user === user &&
              cached?.token === source.token
              ? { ...source, products: cached.products }
              : source;
          }),
        }));
    });
    return () => {
      cancelled = true;
    };
  }, [
    credentialService,
    codingPlanSubscriptionService,
    user,
    identity,
    generation,
    loading,
    refresh,
  ]);
  const planIds: readonly string[] = [
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  ];
  // 账号模型没有 Personal API Key；沿用权益 hook 的只读 Access 判定，不能过滤未选中/禁用套餐。
  const required = planIds
    .filter((providerId) =>
      resolveAccountProviderInspectionAccess(providerSettingsView, providerId),
    )
    .map((providerId) => entitlements[providerId]);
  // 错误描述的是本次刷新，不能否定仍可用的历史快照（含成功确认未开通）。
  const missing = required.filter((item) => {
    const snapshot = item?.snapshot;
    return (
      !snapshot ||
      (snapshot.unavailableReason !== "no_plan" &&
        (!snapshot.authenticated || snapshot.unavailableReason))
    );
  });
  const status = resolveCodingPlanEntryInventoryStatus({
    entitlementLoading: missing.some((item) => item?.loading),
    identity,
    cached: teams,
    generation,
    missingCount: missing.length,
    settingsFailed: state.status === "error",
    settingsLoading: loading,
    teamsResolved: teams ? teams.sources.every((source) => source.products !== null) : false,
    user,
  });
  useEffect(() => {
    logger.debug("[purchaseTelemetry] 套餐入口查询状态", {
      status,
      configuredSources: required.length,
      generation,
    });
  }, [status, required.length, generation]);
  return {
    status,
    retry,
    entryPlanList:
      status === "ready"
        ? buildOwnedEntryPlanList({
            snapshots: required.map((item) => item?.snapshot),
            teamProducts: teams?.sources.flatMap((source) => source.products ?? []) ?? [],
          })
        : "",
  };
}
