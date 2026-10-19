/**
 * OpenCode 用量 API 的数据契约与纯函数（解析/归一化）。
 *
 * Go 套餐用量走公开的 `GET /zen/go/v1/usage`，使用供应商已配置的 API Key 作为 Bearer
 * Token，不需要 Cookie 或 Workspace ID。Zen 余额仍走 Console `billing/status`，需要
 * Cookie 与 `x-org-id`；因此本客户端保留两种认证路径。
 */
import type {
  OpenCodeUsageWindow,
  OpenCodeUsageWindowKey,
  OpenCodeWorkspaceList,
  OpenCodeZenBalanceInfo,
} from "@zcode/shared";

export const OPENCODE_BASE_URL = "https://opencode.ai";
export const CONSOLE_ORGS_URL = `${OPENCODE_BASE_URL}/console/api/orgs`;
export const GO_USAGE_URL = `${OPENCODE_BASE_URL}/zen/go/v1/usage`;
/** Zen 账户余额：使用 Console Cookie + `x-org-id` 鉴权。 */
export const CONSOLE_BILLING_STATUS_URL = `${OPENCODE_BASE_URL}/console/api/billing/status`;

/** Workspace 列表缓存 TTL：与用量快照节流同周期。 */
const WORKSPACE_LIST_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

// 用量接口按浏览器请求校验，非浏览器 UA 会被 Cloudflare 拦截。
export const REQUEST_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

const BARE_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 归一化用户粘贴的凭据：接受原始 token（`Fe26.2**…`）/ 单个 `auth=xxx` /
 * 多对 `a=b; c=d` / 完整 `Cookie:` 头。
 *
 * 不去按 cookie 名白名单过滤：真正管用的是 `__Host-console_session`，但远端会话
 * cookie 名可能变，按名字过滤会把真正管用的那个悄悄丢掉，表现为「凭据看起来没问题但
 * 一律被拒」。用户是从浏览器复制的整段 Cookie，原样回传给同一站点即可。
 * 提取不到任何 `name=value` 且不像 token 时返回空串（调用方按「凭据无效」提示，
 * 不发送畸形请求）。
 */
export function normalizeOpencodeCookieHeader(raw: string): string {
  let input = raw.trim();
  if (input.toLowerCase().startsWith("cookie:")) {
    input = input.slice(7).trim();
  }
  if (!input) return "";

  const pairs: string[] = [];
  for (const segment of input.split(";")) {
    const part = segment.trim();
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || !value) continue;
    pairs.push(`${name}=${value}`);
  }
  if (pairs.length > 0) return pairs.join("; ");

  // 裸 token：只包装形态可辨识的值（Iron Session 密封串或结构化 token），
  // 其余原样拒绝，避免把明显不合法的内容当凭据发出去。
  if (input.startsWith("Fe26.2**") || BARE_TOKEN_PATTERN.test(input)) {
    return `auth=${input}`;
  }
  return "";
}

/** 从裸 ID / 链接等文本里提取 `wrk_xxx`；提取不到返回空字符串。 */
export function normalizeOpencodeWorkspaceId(raw: string): string {
  const match = /wrk_[A-Za-z0-9]+/.exec(raw.trim());
  return match ? match[0] : "";
}

/** console API 的取数结果：401/403 归为凭据问题，其余非 2xx/网络失败按不可用。 */
export type WorkspaceListOutcome =
  | { kind: "ok"; workspaces: Array<{ id: string; name: string }> }
  | {
      kind: "error";
      error: "credential-stale" | "unavailable";
      status: number | null;
    };

export interface OpenCodeConsoleClientDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * console JSON API 的 HTTP 客户端：请求、orgs 列表解析与列表缓存都在这里，
 * 快照/凭据状态所有权在 opencodeUsageService.ts。
 */
export interface OpenCodeConsoleClient {
  /** Go 套餐额度：使用现有 provider API Key，不发送 Cookie 或 Workspace ID。 */
  fetchGoUsage(apiKey: string): Promise<{ status: number; body: string }>;
  request(
    url: string,
    cookieHeader: string,
    options: { accept: string; extraHeaders?: Record<string, string> },
  ): Promise<{
    status: number;
    body: string;
    /** 3xx 的跳转目标。`redirect: "manual"` 下 Node 的 fetch 仍能读到 Location 头。 */
    location: string | null;
  }>;
  /** 拉 orgs 列表并只保留 `wrk_` 条目（无缓存，缓存见 listWorkspaces）。 */
  fetchWorkspaceList(cookie: string): Promise<WorkspaceListOutcome>;
  /** listWorkspaces 的缓存版：按归一化 Cookie 串 60s TTL + in-flight 去重。 */
  listWorkspaces(cookie: string): Promise<OpenCodeWorkspaceList>;
}

export function createOpenCodeConsoleClient(
  dependencies: OpenCodeConsoleClientDependencies,
): OpenCodeConsoleClient {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? Date.now;
  /** Workspace 列表缓存：按 Cookie 串（草稿与已存凭据共用），连续打字与点刷新共享结果。 */
  const workspaceListCache = new Map<string, { fetchedAt: number; list: OpenCodeWorkspaceList }>();
  const inflightWorkspaceList = new Map<string, Promise<OpenCodeWorkspaceList>>();

  async function request(
    url: string,
    cookieHeader: string,
    options: { accept: string; extraHeaders?: Record<string, string> },
  ): Promise<{
    status: number;
    body: string;
    location: string | null;
  }> {
    const response = await fetchImpl(url, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent": REQUEST_USER_AGENT,
        Accept: options.accept,
        ...options.extraHeaders,
      },
      // 不自动跟随：跳转意味着「这次请求没被认可」，自动跟随会拿到登录页的 200，
      // 把「需要重配」伪装成「暂时没有数据」。
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 只取前 4 MiB：JSON 响应在 KiB 量级，限制上限即可。
    const body = (await response.text()).slice(0, 4 << 20);
    return {
      status: response.status,
      body,
      location: response.headers.get("location"),
    };
  }

  async function fetchGoUsage(apiKey: string): Promise<{ status: number; body: string }> {
    const response = await fetchImpl(GO_USAGE_URL, {
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

  async function fetchWorkspaceList(cookie: string): Promise<WorkspaceListOutcome> {
    let result: { status: number; body: string };
    try {
      result = await request(CONSOLE_ORGS_URL, cookie, {
        accept: "application/json",
      });
    } catch {
      return { kind: "error", error: "unavailable", status: null };
    }
    if (result.status === 401 || result.status === 403) {
      return {
        kind: "error",
        error: "credential-stale",
        status: result.status,
      };
    }
    if (result.status < 200 || result.status >= 300) {
      return { kind: "error", error: "unavailable", status: result.status };
    }
    try {
      const parsed = JSON.parse(result.body) as Array<{
        id?: string;
        name?: string;
      }>;
      const workspaces = (Array.isArray(parsed) ? parsed : [])
        .filter((entry) => typeof entry?.id === "string" && entry.id.startsWith("wrk_"))
        .map((entry) => ({
          id: entry.id as string,
          name: typeof entry.name === "string" && entry.name ? entry.name : (entry.id as string),
        }));
      return { kind: "ok", workspaces };
    } catch {
      return { kind: "error", error: "unavailable", status: result.status };
    }
  }

  return {
    fetchGoUsage,
    request,
    fetchWorkspaceList,
    async listWorkspaces(cookie: string): Promise<OpenCodeWorkspaceList> {
      const cached = workspaceListCache.get(cookie);
      if (cached && now() - cached.fetchedAt < WORKSPACE_LIST_TTL_MS) {
        return cached.list;
      }
      const inflight = inflightWorkspaceList.get(cookie);
      if (inflight) return inflight;

      const task = (async (): Promise<OpenCodeWorkspaceList> => {
        const outcome = await fetchWorkspaceList(cookie);
        const list: OpenCodeWorkspaceList =
          outcome.kind === "ok"
            ? { workspaces: outcome.workspaces, error: null }
            : { workspaces: [], error: outcome.error };
        workspaceListCache.set(cookie, { fetchedAt: now(), list });
        return list;
      })();
      inflightWorkspaceList.set(cookie, task);
      try {
        return await task;
      } finally {
        inflightWorkspaceList.delete(cookie);
      }
    },
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
