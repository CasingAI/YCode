import type {
  AccountProviderConnectionResolver,
  AccountProviderConnectionResult,
  ProviderConfigSnapshot,
  ProviderSource,
} from "@zcode/provider";
import { AccountProviderService, createAccountProviderConfigResolver } from "@zcode/provider";
import type {
  ApiClient,
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type {
  CodingPlanAvailabilityProvider,
  CodingPlanAvailabilityResult,
  CodingPlanUnavailableReason,
} from "#src/model-provider/codingPlanProviderAvailability.js";
import {
  validateBigModelAccountProviderAvailability,
  validateZaiAccountProviderAvailability,
} from "#src/model-provider/codingPlanProviderAvailability.js";

export interface AccountProviderConnectionSettings {
  readonly providerFamilyDomain: ProviderFamilyDomain | null;
  readonly selections: ProviderFamilyConnectionSelectionSettings;
  /** Host 旧连接导入尚不能确定身份；仅运行时事实，不写入配置或协议。 */
  readonly unresolvedFamilies?: readonly ProviderFamilyDomain[];
}

export interface AccountProviderFamilyAvailabilityInput {
  readonly family: ProviderFamilyDomain;
  readonly providers: readonly CodingPlanAvailabilityProvider[];
  readonly selections: ProviderFamilyConnectionSelectionSettings;
}

export type AccountProviderFamilyAvailabilityResolver = (
  input: AccountProviderFamilyAvailabilityInput,
) => Promise<Partial<Record<string, CodingPlanAvailabilityResult>>>;

export interface AccountProviderConnectionResolverOptions {
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadCodingPlanApiKey: (
    providerId: string,
    family: ProviderFamilyDomain,
    accountIdentity: string,
    forceRefresh: boolean,
  ) => Promise<string | null>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
  readonly resolveFamilyAvailability: AccountProviderFamilyAvailabilityResolver;
}

export interface CodingPlanFamilyAvailabilityResolverOptions {
  readonly apiClient: ApiClient;
  readonly credentialService?: {
    load(key: string): Promise<string | null>;
  };
}

export interface AccountProviderConfigSourceOptions extends AccountProviderConnectionResolverOptions {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
}

// 智谱剥离：zhipu-account access 已从 provider 定义层删除，账号连接解析
// 无可匹配的 provider，始终返回空连接。删除原因见 docs/specs/zhipu-special-removal.md。
// 保留导出供 node 装配与 desktop 引用。
export function createAccountProviderConnectionResolver(
  _options: AccountProviderConnectionResolverOptions,
): AccountProviderConnectionResolver {
  return async () => Object.freeze([] as AccountProviderConnectionResult[]);
}

function _isCredentialRefreshReason(reason: string): boolean {
  // 保留登录刷新原因判定供后续接入层复用。
  return (
    reason.includes("oauth-callback") || reason.split(":").at(-1) === "oauth-login-entitlement"
  );
}
void _isCredentialRefreshReason;

/**
 * 把 Coding Plan 可用性原因投影为账号域原因。
 * Account State 是跨 family 的通用事实，不直接沿用 Coding Plan 内部枚举；
 * UI 只依赖这里的稳定语义，不认识套餐查询实现。
 */
function _resolveAccountUnavailableReason(
  reason: CodingPlanUnavailableReason,
): import("@zcode/provider").AccountProviderUnavailableReason {
  switch (reason) {
    case "coding_plan_not_authenticated":
      return "not-authenticated";
    case "coding_plan_not_connected":
      return "not-connected";
    case "coding_plan_auth_failed":
      return "credential-failed";
    case "coding_plan_not_entitled":
      return "not-entitled";
  }
}
void _resolveAccountUnavailableReason;

/** 组装 Config、账号连接解析与第三层 Account Provider Config Source。 */
export function createAccountProviderConfigSource(
  options: AccountProviderConfigSourceOptions,
): AccountProviderService {
  return new AccountProviderService({
    configSource: options.configSource,
    resolve: createAccountProviderConfigResolver(createAccountProviderConnectionResolver(options)),
  });
}

/** 用当前稳定的 Plan 查询实现生产 Family Availability Port。 */
export function createCodingPlanFamilyAvailabilityResolver(
  options: CodingPlanFamilyAvailabilityResolverOptions,
): AccountProviderFamilyAvailabilityResolver {
  return ({ family, providers, selections }) => {
    const context = {
      apiClient: options.apiClient,
      credentialService: options.credentialService,
      providerFamilyConnectionSelections: selections,
    };
    return family === "zai"
      ? validateZaiAccountProviderAvailability(providers, context)
      : validateBigModelAccountProviderAvailability(providers, context);
  };
}

export async function resolveCurrentAccountAccess(_input: {
  readonly access: ZCodeProviderAccountAccess;
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
}): Promise<ZCodeAccountAccess | null> {
  // 智谱剥离：zhipu-account access 已删除，无可解析的账号访问，始终返回 null。
  return null;
}
