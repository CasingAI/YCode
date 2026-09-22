/**
 * OpenCode（opencode.ai）套餐用量相关的类型与判定。
 *
 * OpenCode 在本仓库是普通 api-key provider（builtin 模板 opencode-*），
 * 套餐用量能力独立于官方 Z.AI/BigModel Coding Plan 的 entitlement 链路：
 * 用户粘贴 opencode.ai 的整段 Cookie（含 `__Host-console_session`）后，host 进程
 * 走 console JSON API 查询——`GET /console/api/orgs` 列 Workspace，
 * `GET /console/api/go/status`（`x-org-id` 头）读三个窗口的用量。
 * 产品规则见 docs/specs/opencode-usage-quota.md。
 */

export type OpenCodeUsageWindowKey = "rolling" | "weekly" | "monthly";

export interface OpenCodeUsageWindow {
  key: OpenCodeUsageWindowKey;
  /** 远端原样状态，如 "ok" / "rate-limited"。 */
  status: string;
  /** 已用百分比 0-100（接口口径为已用占比，展示端负责反转成剩余）。 */
  usagePercent: number;
  /** 绝对用量/限额（远端数值原样，不做单位换算）；缺失时为 null，此时只展示百分比。 */
  usage: number | null;
  limit: number | null;
  resetInSec: number | null;
  /** 由 resetsAt + 请求时刻推算的 ISO 重置时间；解析不到时为 null。 */
  resetAt: string | null;
}

/**
 * 快照级错误。service 不抛错，统一折叠进快照，UI 按类别展示：
 * - not-configured：未配置凭据，不发请求；
 * - credential-stale：console 会话被拒（401/403），Cookie 已失效；
 * - unavailable：网络失败、5xx，或响应里没有任何可用窗口（不得当作 0% 展示）。
 */
export type OpenCodeUsageErrorKind = "not-configured" | "credential-stale" | "unavailable";

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
  /**
   * wrk_xxx，也接受包含它的链接文本，host 侧提取。
   * 留空 = 自动：host 取 Workspace 列表里第一个 `wrk_` 条目作为默认 Workspace。
   * 填了内容却提取不出 `wrk_…` 时保存会报错（不静默当成自动）。
   */
  workspaceId: string;
}

/** Workspace 下拉选项（来自 `GET /console/api/orgs`，只保留 `wrk_` 前缀条目）。 */
export interface OpenCodeWorkspaceOption {
  id: string;
  name: string;
}

/** Workspace 列表拉取结果：service 不抛错，失败折叠进 error。 */
export interface OpenCodeWorkspaceList {
  workspaces: OpenCodeWorkspaceOption[];
  /** credential-stale=Cookie 被拒；unavailable=网络/5xx；null=成功（或无凭据可用）。 */
  error: "credential-stale" | "unavailable" | null;
}

/** 凭据回显 hint：cookie 只给尾 4 位，不回传原文。 */
export interface OpenCodeUsageCredentialHint {
  cookieTail: string;
  /** 空串表示「自动定位默认 Workspace」。 */
  workspaceId: string;
}

/** OpenCode builtin 模板前缀（opencode-go-* / opencode-zen-*）。 */
export function isOpenCodeProviderTemplateId(templateId: string | null | undefined): boolean {
  return typeof templateId === "string" && templateId.startsWith("opencode-");
}
