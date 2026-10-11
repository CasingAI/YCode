import type {
  ApiClient,
  ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import type { ProviderFamilyDomain } from "@zcode/shared";

// 智谱剥离：zai/bigmodel Coding Plan 权益校验（subscription-list / balance /
// customerInfo / Team Key / StartPlan）已随账号体系下线删除
// （见 docs/specs/zhipu-special-removal.md）。保留类型与函数签名供既有
// 装配引用，统一返回 unknown（无法判定），不发起任何远端请求。

export type CodingPlanUnavailableReason =
  | "coding_plan_not_authenticated"
  | "coding_plan_not_connected"
  | "coding_plan_auth_failed"
  | "coding_plan_not_entitled";

interface CodingPlanAvailabilityContext {
  apiClient?: ApiClient;
  credentialService?: {
    load(key: string): Promise<string | null>;
  };
  providerFamilyConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
}

export type CodingPlanAvailabilityResult =
  | { kind: "available"; models?: readonly string[] }
  | { kind: "pending"; effectiveAt: number; models: readonly string[] }
  | { kind: "unavailable"; reason: CodingPlanUnavailableReason }
  | { kind: "unknown" };

export interface CodingPlanAvailabilityProvider {
  readonly providerId: string;
  readonly family: ProviderFamilyDomain;
  readonly planKind: "start-plan" | "individual-coding-plan" | "team-coding-plan";
  readonly apiKey?: string | null;
}

function unknownResults(
  providers: readonly CodingPlanAvailabilityProvider[],
): Partial<Record<string, CodingPlanAvailabilityResult>> {
  const result: Record<string, CodingPlanAvailabilityResult> = {};
  for (const provider of providers) {
    result[provider.providerId] = { kind: "unknown" };
  }
  return result;
}

export async function validateZaiAccountProviderAvailability(
  providers: readonly CodingPlanAvailabilityProvider[],
  _context: CodingPlanAvailabilityContext,
): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
  return unknownResults(providers);
}

export async function validateBigModelAccountProviderAvailability(
  providers: readonly CodingPlanAvailabilityProvider[],
  _context: CodingPlanAvailabilityContext,
): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
  return unknownResults(providers);
}
