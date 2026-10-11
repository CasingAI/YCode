import type {
  EnterpriseCodingPlanPricingProduct,
  ProviderFamilyConnectionSelection,
  ProviderFamilyDomain,
  UsageEntitlementSnapshot,
} from "@zcode/shared";

export type ModelProviderFamilyConnectionSelection = ProviderFamilyConnectionSelection;

// 智谱剥离：account:* 内置身份已下线，不再有按 family 的 Coding/Team/Start providerId 映射
//（见 docs/specs/zhipu-special-removal.md）。连接选择只保留类型兼容，统一落到个人 Coding 入口。
export function resolveModelProviderFamilyConnectionProviderId(_params: {
  providerFamilyDomain: ProviderFamilyDomain;
  selection: ProviderFamilyConnectionSelection;
}): string {
  return "";
}

export function resolveFirstSubscribedTeamPlanConnectionWithContext(_params: {
  teamProducts: readonly EnterpriseCodingPlanPricingProduct[];
}): Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }> | null {
  return null;
}

export function resolveAutomaticModelProviderFamilyConnectionSelection(_params: {
  providerFamilyDomain: ProviderFamilyDomain;
  codingPlanEntitlement: UsageEntitlementSnapshot | null;
  startPlanEntitlement: UsageEntitlementSnapshot | null;
  teamProducts?: readonly EnterpriseCodingPlanPricingProduct[];
  allowPurchaseEntry?: boolean;
  codingPlanAvailable?: boolean;
  startPlanAvailable?: boolean;
}): ModelProviderFamilyConnectionSelection | null {
  // OAuth 登录后仍需一个默认连接语义；统一返回个人 Coding，不再按权益/团队/Start 分流。
  return {
    kind: "individual-coding-plan",
  };
}
