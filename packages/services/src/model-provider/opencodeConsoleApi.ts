/**
 * OpenCode console JSON API 的数据契约与纯函数（解析/归一化）。
 *
 * 数据路线（2026-09-22 实测）：主站登录体系已下线（`/auth`、`/workspace/<id>/go` 一律
 * 302 到 `/console/login`），唯一可用路线是 console JSON API，认
 * `__Host-console_session` cookie：
 * - Workspace 列表：`GET /console/api/orgs` → `[{id:"wrk_…", name:"…"}, …]`
 * - 用量：`GET /console/api/go/status`，Workspace ID 放在 `x-org-id` 请求头里
 *   （实测放 query/路径都是 400/404）。
 * 本文件是 console 侧的 HTTP 客户端与纯函数（解析/归一化）；快照/凭据状态所有权在
 * opencodeUsageService.ts。
 */
import type {
  OpenCodeUsageWindow,
  OpenCodeUsageWindowKey,
  OpenCodeWorkspaceList,
} from "@zcode/shared";

export const OPENCODE_BASE_URL = "https://opencode.ai";
export const CONSOLE_ORGS_URL = `${OPENCODE_BASE_URL}/console/api/orgs`;
export const CONSOLE_GO_STATUS_URL = `${OPENCODE_BASE_URL}/console/api/go/status`;

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

/** console 的 meters 窗口名 → 快照窗口 key。 */
const METER_KEYS: Array<{
  meter: "fiveHour" | "week" | "month";
  key: OpenCodeUsageWindowKey;
}> = [
  { meter: "fiveHour", key: "rolling" },
  { meter: "week", key: "weekly" },
  { meter: "month", key: "monthly" },
];

interface ConsoleMeter {
  resetsAt?: string;
  limitMicroCents?: string;
  usedMicroCents?: string;
}

export interface ConsoleGoStatus {
  access?: {
    meters?: Partial<Record<"fiveHour" | "week" | "month", ConsoleMeter>>;
  };
}

/** 把 go/status 的 meters 映射为快照窗口；limit 缺失或 ≤0 的窗口跳过（不当 0% 展示）。 */
export function mapGoStatusWindows(
  body: ConsoleGoStatus,
  fetchedAtMs: number,
): OpenCodeUsageWindow[] {
  const meters = body.access?.meters;
  if (!meters) return [];
  const windows: OpenCodeUsageWindow[] = [];
  for (const { meter, key } of METER_KEYS) {
    const entry = meters[meter];
    const limit = Number(entry?.limitMicroCents);
    const usage = Number(entry?.usedMicroCents);
    if (!entry || !Number.isFinite(limit) || limit <= 0) continue;
    const usagePercent = Math.min(
      100,
      Math.max(0, Number.isFinite(usage) ? (usage / limit) * 100 : 0),
    );
    let resetInSec: number | null = null;
    let resetAt: string | null = null;
    if (entry.resetsAt) {
      const resetMs = Date.parse(entry.resetsAt);
      if (Number.isFinite(resetMs)) {
        resetAt = entry.resetsAt;
        resetInSec = Math.max(0, Math.round((resetMs - fetchedAtMs) / 1000));
      }
    }
    windows.push({
      key,
      status: "ok",
      usagePercent,
      usage: Number.isFinite(usage) ? usage : null,
      limit,
      resetInSec,
      resetAt,
    });
  }
  return windows;
}
