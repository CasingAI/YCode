import type {
  ApiClient,
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@zcode/shared";
import type { ProviderTemplateId } from "@zcode/provider";
import type { ICredentialService } from "../credential/credential.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";
import {
  BigModelUsageQuotaProvider,
  type UsageApiAuthorizationRequest,
  type UsageApiAuthorization,
} from "./providers/bigmodelUsageQuotaProvider.js";

interface UsageStatsServiceDependencies {
  apiClient: ApiClient;
  accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  resolveApiAuthorization?: (
    request: UsageApiAuthorizationRequest,
  ) => Promise<UsageApiAuthorization | null>;
  credentialService?: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  /** App Usage 经 ZCode Protocol 读取 agent 数据库真实统计。 */
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  /**
   * 官方 Server MCP 额度的凭证来源。智谱剥离后 MCP 额度链路已删除，
   * 保留字段仅为兼容既有装配。
   */
  officialMcpCredentialSource?: unknown;
  /**
   * 模板自建智谱 provider 的自存信息读取（templateId + API Key）。
   * 装配层从 ProviderConfigService 快照读取，本服务不持有、不落盘密钥。
   */
  resolvePersonalProviderKey?: (providerId: string) => Promise<{
    templateId?: ProviderTemplateId | string | null;
    apiKey?: string | null;
  } | null>;
}

// 智谱剥离：Coding Plan monitor 入口（getCodingPlanUsageSnapshot 等要求
// isCodingPlanModelProviderId）与 StartPlan 快照入口已删除。
// 模板自建智谱 provider 的额度走 personal Key 直查（quota/limit），
// monitor/reset 等账号链路抛错。删除原因见 docs/specs/zhipu-special-removal.md。
export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  const quotaProvider = new BigModelUsageQuotaProvider({
    apiClient: dependencies.apiClient,
    accountRequestAuthService: dependencies.accountRequestAuthService,
    resolveApiAuthorization: dependencies.resolveApiAuthorization,
    credentialService: dependencies.credentialService,
    env: dependencies.env,
    ...(dependencies.resolvePersonalProviderKey
      ? { resolvePersonalProviderKey: dependencies.resolvePersonalProviderKey }
      : {}),
  });

  return {
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      // App Usage 现读取 agent 数据库真实统计（model_usage/turn_usage/tool_usage），
      // 经 ZCode Protocol usage/stats 取回。不再读本地 session JSON 估算。
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
      });
    },
    async getCodingPlanUsageSnapshot(
      _request: CodingPlanUsageRequest,
    ): Promise<CodingPlanUsageSnapshot> {
      throw new Error("coding_plan_monitor_removed");
    },
    async getCodingPlanResetStatus(
      _request: CodingPlanResetScopeRequest,
    ): Promise<CodingPlanResetStatusSnapshot> {
      throw new Error("coding_plan_reset_removed");
    },
    async requestCodingPlanResetOpportunity(
      _request: CodingPlanResetOpportunityRequest,
    ): Promise<CodingPlanResetOpportunityResult> {
      throw new Error("coding_plan_reset_removed");
    },
    async useCodingPlanReset(
      _request: CodingPlanResetUseRequest,
    ): Promise<CodingPlanResetUseResult> {
      throw new Error("coding_plan_reset_removed");
    },
    async markCodingPlanResetHistoryRead(_request: CodingPlanResetScopeRequest): Promise<void> {
      throw new Error("coding_plan_reset_removed");
    },
    async getSnapshot(_request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
      throw new Error("usage_stats_monitor_removed");
    },
    async getEntitlementSnapshot(
      request: UsageEntitlementRequest = {},
    ): Promise<UsageEntitlementSnapshot> {
      return quotaProvider.getSnapshotForRequest(request);
    },
  };
}
