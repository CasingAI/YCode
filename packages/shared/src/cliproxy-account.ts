/**
 * CLI Proxy（cliproxy-* 模板，首批 cliproxy-codex）账号相关的类型与判定。
 *
 * 一个 Codex 账号 = 一个 provider 条目，共享单个代理实例；
 * OAuth 凭据落盘即被代理热加载，我方不写代理 config。
 * 模型清单走数据面 `GET /v1/models` 动态拉取；额度读管理面
 * `GET /v8/management/credentials` 的 `quota.signals`（被动观测，无轮询）。
 * 产品规则见 docs/specs/plugin-cli-proxy-binary.md。
 */

export type CliProxyQuotaWindowKey = "five-hour" | "weekly" | "other";

/** 额度窗口：used_percent 原样（0-100 已用占比），resetAt 解析不到为 null。 */
export interface CliProxyQuotaWindow {
  key: CliProxyQuotaWindowKey;
  /** 上游窗口分钟数原样（如 300≈5 小时、10080≈7 天）；解析不到为 null。 */
  windowMinutes: number | null;
  /** 已用百分比 0–100（signals `used-percent` 原样）。 */
  usagePercent: number;
  /** 由 reset-after-seconds/reset-at 推算的 ISO 重置时间；解析不到为 null。 */
  resetAt: string | null;
}

export type CliProxyQuotaErrorKind =
  | "proxy-stopped"
  | "not-logged-in"
  | "no-observation"
  | "unavailable";

export interface CliProxyQuotaSnapshot {
  providerId: string;
  /** host 侧完成解析的时刻（毫秒）。 */
  fetchedAt: number;
  /** 最后一次观测时刻（credentials `quota.observed_at` 原样 ISO；无则 null）。 */
  observedAt: string | null;
  /** 按窗口分钟数归类后的窗口；为空表示无数据（配 error）。 */
  windows: CliProxyQuotaWindow[];
  /** 透传的上游 plan_type（如 pro/plus/team）；无则 null。 */
  planType: string | null;
  error: CliProxyQuotaErrorKind | null;
  errorMessage: string | null;
}

export interface CliProxyModelEntry {
  id: string;
}

export interface CliProxyModelsSnapshot {
  models: CliProxyModelEntry[];
  fetchedAt: number;
  /** true 表示本次是缓存/回退值而非新鲜拉取。 */
  stale: boolean;
  error: string | null;
}

/** OAuth 登录状态机（浏览器授权为主流程；设备码在 v8.0.27 无管理面端点，作降级提示）。 */
export type CliProxyLoginState =
  | "idle"
  | "starting-proxy"
  | "awaiting-browser"
  | "polling"
  | "succeeded"
  | "failed";

export interface CliProxyLoginStatus {
  state: CliProxyLoginState;
  /** 授权 URL（awaiting-browser 阶段展示/可复制）；其余阶段 null。 */
  authUrl: string | null;
  /** 回调端口 1455 被占时的降级提示；无则 null。 */
  fallbackHint: string | null;
  error: string | null;
}

/**
 * signals 窗口归类：不硬编码 primary=5h，按 `window-minutes` 自行归类
 *（300≈5 小时、10080≈7 天）。某档位只有一个窗口时就是少一个槽位。
 */
export function classifyCliProxyQuotaWindow(windowMinutes: number | null): CliProxyQuotaWindowKey {
  if (windowMinutes === null) return "other";
  // 允许 ±2% 抖动（上游偶发 299/301 这类值）。
  if (Math.abs(windowMinutes - 300) <= 6) return "five-hour";
  if (Math.abs(windowMinutes - 10080) <= 202) return "weekly";
  return "other";
}

function toFiniteNumber(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(num) ? num : null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export interface RawCliProxySignals {
  [key: string]: unknown;
}

/**
 * 从 credentials 条目的 `quota.signals` 解析窗口。
 * primary/secondary 只是上游字段名循环输出、未绑定窗口时长：逐个槽位独立解析，
 * 需 `used-percent` + `window-minutes` + `reset-after/at` 同时合法才收录，缺一丢弃该窗口。
 * signals 键名是小写短横线形态（v8.0.27 二进制实测：used-percent/window-minutes/…）。
 */
export function parseCliProxyQuotaSignals(
  signals: RawCliProxySignals | null | undefined,
  observedAt: string | null,
): { windows: CliProxyQuotaWindow[]; planType: string | null } {
  if (!signals || typeof signals !== "object") return { windows: [], planType: null };
  const planType =
    toNonEmptyString(signals["plan-type"]) ?? toNonEmptyString(signals["plan_type"]);
  const windows: CliProxyQuotaWindow[] = [];
  for (const prefix of ["primary", "secondary"]) {
    const get = (suffix: string): unknown =>
      signals[`${prefix}-${suffix}`] ?? signals[`${prefix}_${suffix}`];
    const usagePercent = toFiniteNumber(get("used-percent"));
    const windowMinutes = toFiniteNumber(get("window-minutes"));
    const resetAfterSeconds = toFiniteNumber(get("reset-after-seconds"));
    const resetAtRaw = toNonEmptyString(get("reset-at"));
    if (usagePercent === null || windowMinutes === null) continue;
    let resetAt: string | null = null;
    if (resetAfterSeconds !== null && resetAfterSeconds >= 0) {
      const base = observedAt ? Date.parse(observedAt) : Date.now();
      if (Number.isFinite(base)) resetAt = new Date(base + resetAfterSeconds * 1000).toISOString();
    } else if (resetAtRaw) {
      const parsed = Date.parse(resetAtRaw);
      if (Number.isFinite(parsed)) resetAt = new Date(parsed).toISOString();
    }
    if (resetAt === null) continue;
    windows.push({
      key: classifyCliProxyQuotaWindow(Math.round(windowMinutes)),
      windowMinutes: Math.round(windowMinutes),
      usagePercent,
      resetAt,
    });
  }
  return { windows, planType };
}

/** 友好化时间："1 分钟内" / "N 分钟前" / "N 小时前"；解析失败返回 null。 */
export function formatCliProxyObservedAgo(observedAt: string | null, nowMs = Date.now()): string | null {
  if (!observedAt) return null;
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return null;
  const diffMs = nowMs - parsed;
  if (diffMs < 0 || diffMs < 60_000) return "1 分钟内";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}
