import type {
  ApiClient,
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
import {
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ICredentialService } from "../../credential/credential.js";
import type { IAccountRequestAuthService } from "../../model-provider/accountRequestAuthService.js";
import { readApiJson } from "../../providers/api/apiJson.js";
import { readEnv } from "../../oauth/providers/configUtils.js";
import type { BigModelUsageQuotaEnvelope } from "./bigmodelUsageQuotaMapper.js";
import { normalizeLimits, pickPrimaryLimit } from "./bigmodelUsageQuotaMapper.js";

const BIGMODEL_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("usage-stats");

// 智谱剥离：智谱账号体系（OAuth / Coding Plan 订阅 / Team / Start Plan）已下线，
// monitor/StartPlan/reset/MCP 等账号链路随之删除（见 docs/specs/zhipu-special-removal.md）。
// 额度查询只保留模板自建智谱 provider 的 personal Key 直查：templateId 为
// zai-api / bigmodel-api / zai-standard-api / bigmodel-standard-api 时，
// 用其自存 API Key 以裸 Key header 调 quota/limit，无需 accountAccess。
const ZHIPU_TEMPLATE_IDS = new Set([
  "zai-api",
  "bigmodel-api",
  "zai-standard-api",
  "bigmodel-standard-api",
]);

export interface UsageApiAuthorizationRequest {
  readonly preferredProviderId?: string;
  readonly requirePreferredProvider: boolean;
}

export interface UsageApiAuthorization {
  readonly authorization: string;
  readonly quotaUrl: string;
  readonly provider: ResolvedQuotaAuthorization["provider"];
}

interface BigModelUsageQuotaProviderOptions {
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
  /**
   * 官方 Server MCP 的凭证来源。智谱剥离后 MCP 额度链路已删除，保留字段仅为兼容既有装配。
   */
  officialMcpCredentialSource?: unknown;
  /**
   * 按 providerId 读取模板自建 provider 的自存信息（templateId + API Key）。
   * 调用方在装配层从 ProviderConfigService 快照读取，本服务不持有、不落盘密钥。
   */
  resolvePersonalProviderKey?: (providerId: string) => Promise<{
    templateId?: string | null;
    apiKey?: string | null;
  } | null>;
}

interface ResolvedQuotaAuthorization {
  authorization: string;
  quotaUrl: string;
  teamContext: null;
  provider: {
    id: string;
    name: string;
  };
}

export class BigModelUsageQuotaProvider {
  private readonly apiClient: ApiClient;
  private readonly accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  private readonly resolveApiAuthorization?: BigModelUsageQuotaProviderOptions["resolveApiAuthorization"];
  private readonly credentialService?: Pick<ICredentialService, "load">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolvePersonalProviderKey?: BigModelUsageQuotaProviderOptions["resolvePersonalProviderKey"];

  constructor(options: BigModelUsageQuotaProviderOptions) {
    this.apiClient = options.apiClient;
    this.accountRequestAuthService = options.accountRequestAuthService;
    this.resolveApiAuthorization = options.resolveApiAuthorization;
    this.credentialService = options.credentialService;
    this.env = options.env ?? process.env;
    this.resolvePersonalProviderKey = options.resolvePersonalProviderKey;
  }

  async getSnapshot(): Promise<UsageEntitlementSnapshot> {
    return this.getSnapshotForRequest({});
  }

  async getSnapshotForRequest(
    request: UsageEntitlementRequest = {},
  ): Promise<UsageEntitlementSnapshot> {
    const generatedAt = Date.now();
    const providerId = request.preferredProviderId?.trim() ?? "";

    // 模板自建智谱 provider：用自存 API Key 直查 quota/limit，无需 accountAccess。
    if (providerId && this.resolvePersonalProviderKey) {
      const personal = await this.resolvePersonalProviderKey(providerId).catch(() => null);
      const templateId = personal?.templateId?.trim() ?? "";
      const apiKey = personal?.apiKey?.trim() ?? "";
      if (templateId && ZHIPU_TEMPLATE_IDS.has(templateId) && apiKey) {
        return this.getTemplateQuotaSnapshot(providerId, templateId, apiKey, generatedAt);
      }
    }

    let resolved: ResolvedQuotaAuthorization | null = null;
    try {
      resolved = await this.resolveAuthorization({
        preferredProviderId: request.preferredProviderId,
        requirePreferredProvider: request.requirePreferredProvider === true,
        allowEnvApiKey: request.allowEnvApiKey,
      });
    } catch (error) {
      log.warn(undefined, "读取用量凭据失败，返回降级快照", {
        error: error instanceof Error ? error.message : String(error),
        preferredProviderId: providerId,
      });
    }
    if (!resolved) {
      // 无凭据的未配置状态正常返回，不抛错。
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "not_configured",
        context: { scope: "personal" },
        provider: null,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }
    try {
      const payload = await this.fetchQuota(resolved);
      return this.buildQuotaSnapshot(resolved, payload, generatedAt);
    } catch (error) {
      // 失败时返回带降级标记的快照，不抛错、不阻断 provider 保存与聊天。
      log.warn(undefined, "quota/limit 查询失败，返回降级快照", {
        error: error instanceof Error ? error.message : String(error),
        preferredProviderId: providerId,
      });
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "unavailable",
        context: { scope: "personal" },
        provider: resolved.provider,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }
  }

  /**
   * 模板自建智谱 provider 的 quota/limit 直查。
   * 失败返回带降级标记的快照（remaining 为 null + unavailableReason），不抛错。
   */
  private async getTemplateQuotaSnapshot(
    providerId: string,
    templateId: string,
    apiKey: string,
    generatedAt: number,
  ): Promise<UsageEntitlementSnapshot> {
    const family = templateId.startsWith("zai") ? "zai" : "bigmodel";
    const resolved: ResolvedQuotaAuthorization = {
      authorization: apiKey,
      quotaUrl:
        resolveQuotaUrlFromEnv(this.env) ??
        (family === "zai" ? buildZaiQuotaUrl(this.env) : buildBigModelQuotaUrl(this.env)),
      teamContext: null,
      provider: { id: providerId, name: family === "zai" ? "Z.ai" : "BigModel" },
    };
    try {
      const payload = await this.fetchQuota(resolved);
      return this.buildQuotaSnapshot(resolved, payload, generatedAt);
    } catch (error) {
      log.warn(undefined, "模板智谱 provider quota/limit 查询失败，返回降级快照", {
        error: error instanceof Error ? error.message : String(error),
        providerId,
        templateId,
      });
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "unavailable",
        context: { scope: "personal" },
        provider: resolved.provider,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }
  }

  private buildQuotaSnapshot(
    resolved: ResolvedQuotaAuthorization,
    payload: BigModelUsageQuotaEnvelope,
    generatedAt: number,
  ): UsageEntitlementSnapshot {
    const quotaData = isSuccessfulBigModelEnvelope(payload) ? (payload.data ?? null) : null;
    const limits = normalizeLimits(quotaData?.limits);
    const primaryLimit = pickPrimaryLimit(limits);
    // 非成功 envelope（无 monitor 权限、Key 无效等）降级展示，不抛错。
    if (!quotaData) {
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "unavailable",
        context: { scope: "personal" },
        provider: resolved.provider,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }
    return {
      generatedAt,
      authenticated: true,
      context: { scope: "personal" },
      provider: resolved.provider,
      remaining: primaryLimit
        ? {
            count: primaryLimit.remaining ?? 0,
            isShow: true,
            percentage: primaryLimit.percentage,
            nextResetTime: primaryLimit.nextResetTime ?? null,
          }
        : null,
      subscription: null,
      quota: { level: quotaData.level?.trim() || null, limits },
    };
  }

  // 智谱剥离：Coding Plan monitor（model-usage/tool-usage）、StartPlan 快照、
  // reset、MCP 等账号链路已删除。接口保留以兼容既有调用方，调用时显式抛错。
  async getUsageStatsSnapshot(_request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
    throw new Error("usage_stats_monitor_removed");
  }

  async getCodingPlanResetStatus(
    _request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot> {
    throw new Error("coding_plan_reset_removed");
  }

  async useCodingPlanReset(_request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult> {
    throw new Error("coding_plan_reset_removed");
  }

  async requestCodingPlanResetOpportunity(
    _request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult> {
    throw new Error("coding_plan_reset_removed");
  }

  async markCodingPlanResetHistoryRead(_request: CodingPlanResetScopeRequest): Promise<void> {
    throw new Error("coding_plan_reset_removed");
  }

  async getCodingPlanUsageSnapshot(
    _request: CodingPlanUsageRequest,
  ): Promise<CodingPlanUsageSnapshot> {
    throw new Error("coding_plan_monitor_removed");
  }

  private async resolveAuthorization(
    request: {
      preferredProviderId?: string;
      requirePreferredProvider?: boolean;
      allowEnvApiKey?: boolean;
    } = {},
  ): Promise<ResolvedQuotaAuthorization | null> {
    if (request.allowEnvApiKey !== false && request.requirePreferredProvider !== true) {
      const envApiKey =
        readEnv(this.env, "ZCODE_BIGMODEL_USAGE_API_KEY") ??
        readEnv(this.env, "BIGMODEL_USAGE_API_KEY");
      if (envApiKey) {
        return {
          authorization: envApiKey,
          quotaUrl: resolveQuotaUrlFromEnv(this.env) ?? buildBigModelQuotaUrl(this.env),
          teamContext: null,
          provider: {
            id: "env:bigmodel-usage",
            name: "BigModel",
          },
        };
      }
    }

    const providerId = request.preferredProviderId?.trim() ?? "";
    const apiAuthorization = await this.resolveApiAuthorization?.({
      preferredProviderId: providerId || undefined,
      requirePreferredProvider: request.requirePreferredProvider === true,
    });
    return apiAuthorization ? { ...apiAuthorization, teamContext: null } : null;
  }

  private async fetchQuota(
    resolved: ResolvedQuotaAuthorization,
  ): Promise<BigModelUsageQuotaEnvelope> {
    return readApiJson<BigModelUsageQuotaEnvelope>(this.apiClient, resolved.quotaUrl, {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: createBigModelUsageHeaders(resolved),
    });
  }

  // 兼容保留：既有装配仍可访问，避免未使用的成员告警。
  private get credentialServiceRef(): Pick<ICredentialService, "load"> | undefined {
    return this.credentialService;
  }

  private get accountRequestAuthServiceRef(): Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  > {
    return this.accountRequestAuthService;
  }
}

function createBigModelUsageHeaders(resolved: ResolvedQuotaAuthorization): Record<string, string> {
  return {
    // quota/limit 接口要求 authorization 直接传完整凭据（裸 Key）。
    // 模板自建 provider 用自存 Coding Plan Key，不能额外加 Bearer 前缀。
    authorization: resolved.authorization,
  };
}

function isSuccessfulBigModelEnvelope(payload: { code?: number; success?: boolean }): boolean {
  const code = payload.code;
  return (
    payload.success !== false && (code === undefined || code === null || code === 0 || code === 200)
  );
}

function resolveQuotaUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return readEnv(env, "ZCODE_BIGMODEL_USAGE_QUOTA_URL") ?? readEnv(env, "BIGMODEL_USAGE_QUOTA_URL");
}

function buildBigModelQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  return buildBigModelApiUrl(env, BIGMODEL_QUOTA_PATH);
}

function buildZaiQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  // ZAI usage/quota 与 business login 共用业务域名。
  // 测试环境必须请求配置的 ZAI Business origin，不能把测试 token 发送到生产 api.z.ai。
  return buildRuntimeZaiBusinessUrl(env, "/api/monitor/usage/quota/limit");
}
