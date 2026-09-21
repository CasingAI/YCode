/**
 * OpenCode（opencode.ai）套餐用量相关的类型与判定。
 *
 * OpenCode 在本仓库是普通 api-key provider（builtin 模板 opencode-*），
 * 套餐用量能力独立于官方 Z.AI/BigModel Coding Plan 的 entitlement 链路：
 * 用户粘贴 opencode.ai 登录 Cookie（auth）与 Workspace ID 后，
 * host 进程解析 workspace Go 页面内嵌 store state 得到三窗口用量。
 * 产品规则见 docs/specs/opencode-usage-quota.md。
 */

export type OpenCodeUsageWindowKey = "rolling" | "weekly" | "monthly";

export interface OpenCodeUsageWindow {
  key: OpenCodeUsageWindowKey;
  /** 页面原样状态，如 "ok" / "rate-limited"。 */
  status: string;
  /** 已用百分比 0-100（页面口径为已用占比，展示端负责反转成剩余）。 */
  usagePercent: number;
  /** 绝对用量/限额（token 数）；页面缺失该字段时为 null，此时只展示百分比。 */
  usage: number | null;
  limit: number | null;
  resetInSec: number | null;
  /** 由 resetInSec + 请求时刻推算的 ISO 重置时间；解析不到时为 null。 */
  resetAt: string | null;
}

/**
 * 快照级错误。service 不抛错，统一折叠进快照，UI 按类别展示：
 * - not-configured：未配置凭据，不发请求；
 * - credential-stale：401/403，Cookie 过期或无效；
 * - workspace-not-found：404，Workspace ID 错误；
 * - unavailable：网络失败或页面结构变化导致解析不到任何窗口（不得当作 0% 展示）。
 */
export type OpenCodeUsageErrorKind =
  | "not-configured"
  | "credential-stale"
  | "workspace-not-found"
  | "unavailable";

export interface OpenCodeUsageSnapshot {
  providerId: string;
  /** 实际使用的 workspace id；未配置或校验失败时为 null。 */
  workspaceId: string | null;
  /** host 侧完成解析的时刻（毫秒）。 */
  fetchedAt: number;
  windows: OpenCodeUsageWindow[];
  error: OpenCodeUsageErrorKind | null;
  /** 面向日志的可读补充信息，绝不包含 cookie 原文。 */
  errorMessage: string | null;
}

export interface OpenCodeUsageCredentialInput {
  providerId: string;
  /** auth Cookie 值，接受裸值 / auth=xxx / 整段 Cookie 头，host 侧归一化。 */
  authCookie: string;
  /** wrk_xxx，也接受包含它的页面/链接文本，host 侧提取。 */
  workspaceId: string;
}

/** 凭据回显 hint：cookie 只给尾 4 位，不回传原文。 */
export interface OpenCodeUsageCredentialHint {
  cookieTail: string;
  workspaceId: string;
}

/** OpenCode builtin 模板前缀（opencode-go-* / opencode-zen-*）。 */
export function isOpenCodeProviderTemplateId(templateId: string | null | undefined): boolean {
  return typeof templateId === "string" && templateId.startsWith("opencode-");
}
