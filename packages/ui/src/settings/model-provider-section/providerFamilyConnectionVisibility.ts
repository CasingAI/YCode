import type {
  ProviderFamilyConnectionSelection,
  ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import type { CodingPlanEntitlementState } from "@/settings/model-provider-section/constants.js";

// 智谱剥离：family 连接可见性规则已下线（见 docs/specs/zhipu-special-removal.md）。
// 保留导出签名兼容旧引用，统一返回空/默认，不再按权益/团队/Start 分流。

export function resolveCodingPlanEntitlementState(_params: {
  providerId: string;
  accountEntitled: boolean;
  accountAvailability?: unknown;
  accountUnavailableReason?: unknown;
  entitlement?: CodingPlanEntitlementState;
  modelProvidersLoading: boolean;
}): {
  status: "disconnected";
  planLevel: null;
  currentProductId: null;
  subscriptionBillingCycle: null;
  subscriptionRenewTime: null;
  subscriptionExpireTime: null;
  quotaLimits: [];
} {
  return {
    status: "disconnected",
    planLevel: null,
    currentProductId: null,
    subscriptionBillingCycle: null,
    subscriptionRenewTime: null,
    subscriptionExpireTime: null,
    quotaLimits: [],
  };
}

export function buildVisibleFamilyConnectionItems(_params: {
  items: never[];
  codingPlanEntitlements?: Partial<Record<string, CodingPlanEntitlementState>>;
  subscribedTeamProducts: never[];
  showPurchasedTeamPlanFallback: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  teamPlanSelections?: Partial<Record<string, unknown>>;
}): never[] {
  return [];
}

export function connectionSelectionMatchesNavigationItem(
  _family: string,
  _selection: ProviderFamilyConnectionSelection,
  _item: unknown,
): boolean {
  return false;
}
