/**
 * OpenCode（opencode.ai）套餐用量相关的类型与判定。
 *
 * OpenCode 在本仓库是普通 api-key provider（builtin 模板 opencode-*），
 * Go 套餐用量与 Zen 余额均复用 provider 已配置的 API Key，由 Host 通过 Bearer 认证查询。
 * 产品规则见 docs/specs/opencode-usage-quota.md。
 */

export type OpenCodeUsageWindowKey = "rolling" | "weekly" | "monthly";

export interface OpenCodeUsageWindow {
  key: OpenCodeUsageWindowKey;
  /** 远端原样状态，如 "ok" / "rate-limited"。 */
  status: string;
  /**
   * 已用百分比 0-100（接口口径为已用占比，展示端负责反转成剩余）。
   */
  usagePercent: number;
  /** 当前 Go usage API 不返回已用金额，因此保持 null，只展示百分比。 */
  usage: number | null;
  /** 当前 Go usage API 不返回额度上限，因此保持 null，不根据旧版固定额度推算。 */
  limit: number | null;
  resetInSec: number | null;
  /** 由 resetsAt + 请求时刻推算的 ISO 重置时间；解析不到时为 null。 */
  resetAt: string | null;
}

/**
 * 快照级错误。service 不抛错，统一折叠进快照，UI 按类别展示：
 * - not-configured：未配置凭据，不发请求；
 * - credential-stale：Go 或 Zen API Key 被拒（401/403）；
 * - subscription-required：API 返回 403，未找到该 Key 对应的可用 Go 用量记录；也可能是服务端关联异常；
 * - unavailable：网络失败、5xx，或响应里没有任何可用窗口（不得当作 0% 展示）。
 */
export type OpenCodeUsageErrorKind =
  | "not-configured"
  | "credential-stale"
  | "subscription-required"
  | "unavailable";

export interface OpenCodeUsageSnapshot {
  providerId: string;
  /** host 侧完成解析的时刻（毫秒）。 */
  fetchedAt: number;
  /** Go API Key 身份的内存代数；更换 Key 时 renderer 必须丢弃旧账号 last-good。 */
  credentialRevision?: number;
  windows: OpenCodeUsageWindow[];
  error: OpenCodeUsageErrorKind | null;
  /** 面向日志的可读补充信息，不包含凭据原文。 */
  errorMessage: string | null;
}

/** OpenCode builtin 模板前缀（opencode-go-* / opencode-zen-*）。 */
export function isOpenCodeProviderTemplateId(templateId: string | null | undefined): boolean {
  return typeof templateId === "string" && templateId.startsWith("opencode-");
}

/**
 * CLI Proxy builtin 模板（cliproxy-*，首批 cliproxy-codex）：
 * 一个 Codex 账号 = 一个 provider 条目，共享单个代理实例；
 * 模型清单走数据面 /v1/models 动态拉取，额度读管理面 credentials。
 */
export function isCliProxyProviderTemplateId(templateId: string | null | undefined): boolean {
  return typeof templateId === "string" && templateId.startsWith("cliproxy-");
}

/**
 * Go 订阅制模板（opencode-go-*）：查 `/zen/go/v1/usage` 三窗口套餐用量，使用现有 API Key。
 * 宽泛的 `isOpenCodeProviderTemplateId` 只保留给侧栏分组与图标共用，
 * 数据组件挂载必须用本函数与 Zen 区分。
 */
export function isOpenCodeGoProviderTemplateId(templateId: string | null | undefined): boolean {
  return typeof templateId === "string" && templateId.startsWith("opencode-go-");
}

/**
 * Zen 按量付费模板（opencode-zen-*）：查 console `/console/api/billing/status` 账户余额。
 * 使用该 Provider 已配置的 API Key 通过 Bearer 鉴权（余额无窗口/重置时间）。
 */
export function isOpenCodeZenProviderTemplateId(templateId: string | null | undefined): boolean {
  return typeof templateId === "string" && templateId.startsWith("opencode-zen-");
}

/** Zen 单币种余额：金额解析不出有限数值时为 null，绝不当作 0 展示。 */
export interface OpenCodeZenBalanceInfo {
  /** 远端原文，如 "USD"；未知币种也原样透出。 */
  currency: string;
  /** 账户余额（剩余额度）。 */
  amount: number | null;
}

export interface OpenCodeZenBalanceSnapshot {
  providerId: string;
  /** host 侧完成解析的时刻（毫秒）。 */
  fetchedAt: number;
  /** API Key 身份代数；更换 Key 后 renderer 必须丢弃旧账号余额。 */
  credentialRevision?: number;
  /** 余额条目；为空表示无数据（配 error）。 */
  balances: OpenCodeZenBalanceInfo[];
  error: OpenCodeUsageErrorKind | null;
  /** 面向日志的可读补充信息，不包含凭据原文。 */
  errorMessage: string | null;
}
