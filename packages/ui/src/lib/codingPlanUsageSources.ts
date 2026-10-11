import type {
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type {
  SidebarUsageCodingPlanProviderId,
  SidebarUsageCodingPlanSourceId,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

// 智谱剥离：套餐用量来源组装已下线（见 docs/specs/zhipu-special-removal.md）。
// 保留类型与函数签名兼容旧引用，一律返回空，不再按 family/团队分流。
export interface CodingPlanUsageSource {
  id: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  label: string;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

export function buildPersonalCodingPlanUsageSource(_params: {
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label?: string | null;
}): CodingPlanUsageSource {
  return {
    id: _params.providerId,
    providerId: _params.providerId,
    accountAccess: _params.accountAccess,
    label: _params.label?.trim() || String(_params.providerId),
  };
}

export function buildCodingPlanUsageSources(_params: {
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  subscribedTeamProducts: unknown[];
}): CodingPlanUsageSource[] {
  return [];
}

export function resolveSidebarCurrentCodingPlanUsageSource(_params: {
  selections?: ProviderFamilyConnectionSelectionSettings | null;
  selectedProviderId: string | null;
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  teamSources: CodingPlanUsageSource[];
}): null {
  return null;
}
