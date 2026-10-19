/**
 * OpenCode 用量 API 的数据契约与纯函数（解析/归一化）。
 * Go 套餐与 Zen 余额均复用各自 Provider 已配置的 API Key，通过 Bearer 认证；
 * 两条路线都不需要 Cookie 或 Workspace ID。
 */
import type {
  OpenCodeUsageWindow,
  OpenCodeUsageWindowKey,
  OpenCodeZenBalanceInfo,
} from "@zcode/shared";

export const OPENCODE_BASE_URL = "https://opencode.ai";
export const GO_USAGE_URL = `${OPENCODE_BASE_URL}/zen/go/v1/usage`;
export const CONSOLE_BILLING_STATUS_URL = `${OPENCODE_BASE_URL}/console/api/billing/status`;

const REQUEST_TIMEOUT_MS = 20_000;
export const REQUEST_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

export interface OpenCodeConsoleClientDependencies {
  fetchImpl?: typeof fetch;
}

export interface OpenCodeConsoleClient {
  /** Go 订阅额度：Bearer API Key，无 Cookie/Workspace。 */
  fetchGoUsage(apiKey: string): Promise<{ status: number; body: string }>;
  /** Zen 账户余额：Console billing/status 接受同一 Provider API Key 的 Bearer 认证。 */
  fetchZenBalance(apiKey: string): Promise<{ status: number; body: string }>;
}

export function createOpenCodeConsoleClient(
  dependencies: OpenCodeConsoleClientDependencies,
): OpenCodeConsoleClient {
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  async function fetchBearerJson(
    url: string,
    apiKey: string,
  ): Promise<{ status: number; body: string }> {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": REQUEST_USER_AGENT,
        Accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return {
      status: response.status,
      body: (await response.text()).slice(0, 4 << 20),
    };
  }

  return {
    fetchGoUsage: (apiKey) => fetchBearerJson(GO_USAGE_URL, apiKey),
    fetchZenBalance: (apiKey) => fetchBearerJson(CONSOLE_BILLING_STATUS_URL, apiKey),
  };
}

/**
 * Zen Console 金额字段的统一口径：微美分，1 美元 = 1e8 微美分。
 * Go 用量接口只返回百分比，不应在这里做金额换算或猜测额度上限。
 */
export const MICRO_CENTS_PER_USD = 100_000_000;

interface GoUsageWindowResponse {
  status?: unknown;
  percent?: unknown;
  resetsAt?: unknown;
}

export interface GoUsageResponse {
  usage?: Partial<Record<OpenCodeUsageWindowKey, GoUsageWindowResponse>>;
}

/** billing/status 的余额形态：字段名以真实响应为准，解析层做宽容匹配。 */
export interface ConsoleBillingStatus {
  balance?: unknown;
  credits?: unknown;
  amount?: unknown;
  data?: unknown;
  /**
   * 2026-10-07 实测（prepaid/pay-as-you-go 账户）的真实金额字段：微美分字符串
   * （1 美元 = 1e8 微美分），无币种字段。balance 是充值余额，
   * available 是余额 + 授信。
   */
  balanceMicroCents?: unknown;
  availableMicroCents?: unknown;
  creditLimitMicroCents?: unknown;
}

function parseBillingAmount(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 微美分字符串 → 美元数值；缺失/非法返回 null（由调用方决定回退或按 unavailable 上报）。 */
function parseMicroCentsAmount(value: unknown): number | null {
  const microCents = parseBillingAmount(value);
  return microCents === null ? null : microCents / MICRO_CENTS_PER_USD;
}

function readBillingCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 把 billing/status 映射为余额条目。真实 schema（2026-10-07 抓包）是顶层的
 * `balanceMicroCents`（微美分字符串，无币种字段，默认 USD）——注意 `"0"` 是合法余额
 * （prepaid 账户没充值过），必须照常展示 `$0`，不能当「解析失败」。
 * 微美分字段缺失时才回退到宽容匹配：顶层或 `data` 下的 `balance` / `credits` /
 * `amount`（数字或十进制字符串），币种取同级 `currency` 字段。宽容匹配形态按美元
 * 原值处理，不做微美分换算。所有金额都解析不出时
 * 返回空数组，由调用方按 unavailable 上报（不得当作 0 展示）。
 */
export function mapBillingStatusBalance(body: ConsoleBillingStatus): OpenCodeZenBalanceInfo[] {
  if (!body || typeof body !== "object") return [];
  const scopes: unknown[] = [body];
  const data = (body as { data?: unknown }).data;
  if (data && typeof data === "object") scopes.push(data);
  for (const scope of scopes) {
    const record = scope as Record<string, unknown>;
    // 真实字段优先：balanceMicroCents 是充值余额；availableMicroCents（余额 + 授信）
    // 只在 balance 缺失时兜底，避免授信额度被误读成余额。
    const microCentsAmount =
      parseMicroCentsAmount(record["balanceMicroCents"]) ??
      parseMicroCentsAmount(record["availableMicroCents"]);
    if (microCentsAmount !== null) {
      const currency = readBillingCurrency(record["currency"]) ?? "USD";
      return [{ currency, amount: microCentsAmount }];
    }
    // 宽容匹配分支是有意不换算的：这些字段名是旧假设的美元原值形态，
    // 与微美分字符串字段互斥——只有微美分字段全缺失才走到这里，
    // 因此按美元原值直接使用，不除以 MICRO_CENTS_PER_USD。
    // 嵌套形态：{ balance: { amount, currency } } / { credits: { ... } }。
    for (const key of ["balance", "credits", "amount"]) {
      const nested = record[key];
      if (nested && typeof nested === "object") {
        const nestedRecord = nested as Record<string, unknown>;
        const amount =
          parseBillingAmount(nestedRecord["amount"]) ??
          parseBillingAmount(nestedRecord["credits"]) ??
          parseBillingAmount(nestedRecord["balance"]) ??
          parseBillingAmount(nestedRecord["value"]);
        if (amount !== null) {
          const currency =
            readBillingCurrency(nestedRecord["currency"]) ??
            readBillingCurrency(record["currency"]) ??
            "USD";
          return [{ currency, amount }];
        }
      }
    }
    // 顶层扁平形态同样按美元原值处理（同上，不做微美分换算）。
    const amount =
      parseBillingAmount(record["balance"]) ??
      parseBillingAmount(record["credits"]) ??
      parseBillingAmount(record["amount"]) ??
      parseBillingAmount(record["remaining"]) ??
      parseBillingAmount(record["value"]);
    if (amount !== null) {
      const currency = readBillingCurrency(record["currency"]) ?? "USD";
      return [{ currency, amount }];
    }
  }
  return [];
}

/** 把 `/zen/go/v1/usage` 的百分比窗口映射为快照；不猜测接口未返回的金额。 */
export function mapGoUsageWindows(
  body: GoUsageResponse,
  fetchedAtMs: number,
): OpenCodeUsageWindow[] {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") return [];
  const entries: Array<{ key: OpenCodeUsageWindowKey; entry: GoUsageWindowResponse | undefined }> =
    [
      { key: "rolling", entry: usage.rolling },
      { key: "weekly", entry: usage.weekly },
      { key: "monthly", entry: usage.monthly },
    ];
  const windows: OpenCodeUsageWindow[] = [];
  for (const { key, entry } of entries) {
    if (
      !entry ||
      (entry.status !== "ok" && entry.status !== "rate-limited") ||
      typeof entry.percent !== "number" ||
      !Number.isFinite(entry.percent)
    ) {
      continue;
    }
    const usagePercent = Math.min(100, Math.max(0, entry.percent));
    let resetInSec: number | null = null;
    let resetAt: string | null = null;
    // 上游在 0% 时会返回一个占位重置时间，不把它误显示为真实重置时刻。
    if (usagePercent > 0 && typeof entry.resetsAt === "string") {
      const resetMs = Date.parse(entry.resetsAt);
      if (Number.isFinite(resetMs)) {
        resetAt = entry.resetsAt;
        resetInSec = Math.max(0, Math.round((resetMs - fetchedAtMs) / 1000));
      }
    }
    windows.push({
      key,
      status: entry.status,
      usagePercent,
      usage: null,
      limit: null,
      resetInSec,
      resetAt,
    });
  }
  return windows;
}
