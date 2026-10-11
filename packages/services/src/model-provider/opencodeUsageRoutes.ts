import type {
  OpenCodeUsageSnapshot,
  OpenCodeZenBalanceSnapshot,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  CONSOLE_BILLING_STATUS_URL,
  CONSOLE_GO_STATUS_URL,
  type ConsoleBillingStatus,
  type ConsoleGoStatus,
  type OpenCodeConsoleClient,
  mapBillingStatusBalance,
  mapGoStatusWindows,
  normalizeOpencodeCookieHeader,
} from "./opencodeConsoleApi.js";
import {
  type OpenCodeUsageCaches,
  type OpenCodeUsageCredentialRecord,
  credentialKey,
} from "./opencodeUsageState.js";

// ============================================================
// OpenCode 用量服务的数据路线（console JSON API 取数）
// ============================================================
// 原因与 background 拆分同形：opencodeUsageService.ts 基线超行，主文件只
// 保留编排（缓存读写 + 公开方法），取数函数（纯 data-plane：consoleClient
// 请求 + 解析 + 路由 outcome）下沉到本模块。行为零改动。

/** 取数结果：auth-rejected=远端明确拒绝（401/403）；no-data 带状态码（拿不到响应为 null）。 */
export type UsageRouteOutcome =
  | { kind: "snapshot"; snapshot: OpenCodeUsageSnapshot }
  | { kind: "auth-rejected"; status: number }
  | { kind: "no-data"; status: number | null };

export type ZenRouteOutcome =
  | { kind: "snapshot"; snapshot: OpenCodeZenBalanceSnapshot }
  | { kind: "auth-rejected"; status: number }
  | { kind: "no-data"; status: number | null };

export interface UsageRouteDeps {
  credentialService: Pick<
    import("../credential/credential.js").ICredentialService,
    "load"
  >;
  consoleClient: OpenCodeConsoleClient;
  logger: ServiceLogger;
  now: () => number;
  caches: OpenCodeUsageCaches;
}

export async function loadCredential(
  deps: UsageRouteDeps,
  providerId: string,
): Promise<OpenCodeUsageCredentialRecord | null> {
  const raw = await deps.credentialService.load(credentialKey(providerId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OpenCodeUsageCredentialRecord;
    if (!parsed?.authCookie) return null;
    // workspaceId 允许是空串：空 = 自动定位默认 Workspace（见 resolveWorkspaceId）。
    return { ...parsed, workspaceId: parsed.workspaceId ?? "" };
  } catch {
    deps.logger.warn(undefined, "凭据记录损坏，按未配置处理", { providerId });
    return null;
  }
}

/**
 * 解析出本次请求用的 Cookie：草稿非空用草稿（归一化），否则用已保存凭据。
 * 两者皆无返回 null（调用方按「还没有可用凭据」处理，不发请求）。
 */
export async function resolveCookie(
  deps: UsageRouteDeps,
  providerId: string,
  authCookieDraft: string,
): Promise<{ cookie: string; savedAt: number } | null> {
  const draft = authCookieDraft.trim();
  if (draft) {
    const normalized = normalizeOpencodeCookieHeader(draft);
    return normalized ? { cookie: normalized, savedAt: 0 } : null;
  }
  const credential = await loadCredential(deps, providerId);
  return credential ? { cookie: credential.authCookie, savedAt: credential.savedAt } : null;
}

/**
 * 定位要读的那个 Workspace：显式选了就用选的，留空则取 Workspace 列表的第一个
 * `wrk_` 条目（console 把默认 Workspace 排在首位，实测如此）。结果按凭据缓存在
 * 内存（同一次会话里默认 Workspace 不变），免得每次刷新都多打一发。
 *
 * Cookie 失效时列表请求 401，返回 auth-rejected 交给调用方按需要重配上报。
 */
export async function resolveWorkspaceId(
  deps: UsageRouteDeps,
  providerId: string,
  credential: OpenCodeUsageCredentialRecord,
): Promise<
  | { kind: "workspace"; workspaceId: string }
  | { kind: "auth-rejected"; status: number }
  | { kind: "no-data"; status: number | null }
> {
  if (credential.workspaceId) return { kind: "workspace", workspaceId: credential.workspaceId };
  const cached = deps.caches.workspaceIdCache.get(providerId);
  if (cached && cached.savedAt === credential.savedAt) {
    return { kind: "workspace", workspaceId: cached.workspaceId };
  }

  const list = await deps.consoleClient.fetchWorkspaceList(credential.authCookie);
  if (list.kind === "error") {
    deps.logger.info(undefined, "未能从 orgs 列表定位默认 Workspace", {
      providerId,
      error: list.error,
      status: list.status,
    });
    return list.error === "credential-stale"
      ? { kind: "auth-rejected", status: list.status ?? 401 }
      : { kind: "no-data", status: list.status };
  }
  const first = list.workspaces[0];
  if (!first) {
    // 账号里没有任何 wrk_ workspace：没有可查的对象，按不可用处理。
    deps.logger.info(undefined, "orgs 列表里没有 wrk_ workspace", { providerId });
    return { kind: "no-data", status: 200 };
  }
  deps.caches.workspaceIdCache.set(providerId, {
    savedAt: credential.savedAt,
    workspaceId: first.id,
  });
  return { kind: "workspace", workspaceId: first.id };
}

/**
 * 唯一数据路线：console go/status。请求成功但没有可用窗口时返回 no-data，
 * 由调用方按 unavailable 处理（绝不当作 0% 展示）。
 */
export async function fetchFromConsole(
  deps: UsageRouteDeps,
  providerId: string,
  credential: OpenCodeUsageCredentialRecord,
): Promise<UsageRouteOutcome> {
  const located = await resolveWorkspaceId(deps, providerId, credential);
  if (located.kind !== "workspace") return located;
  const workspaceId = located.workspaceId;

  let result: { status: number; body: string };
  try {
    result = await deps.consoleClient.request(CONSOLE_GO_STATUS_URL, credential.authCookie, {
      accept: "application/json",
      extraHeaders: { "x-org-id": workspaceId },
    });
  } catch {
    return { kind: "no-data", status: null };
  }
  const { status, body } = result;
  if (status === 401 || status === 403) return { kind: "auth-rejected", status };
  if (status < 200 || status >= 300) return { kind: "no-data", status };

  let parsed: ConsoleGoStatus;
  try {
    parsed = JSON.parse(body) as ConsoleGoStatus;
  } catch {
    deps.logger.warn(undefined, "go/status 响应不是合法 JSON", {
      providerId,
      status,
    });
    return { kind: "no-data", status };
  }
  const fetchedAt = deps.now();
  const windows = mapGoStatusWindows(parsed, fetchedAt);
  if (windows.length === 0) {
    // 200 却没有窗口：要么该 workspace 没启用 Go 套餐（正常），要么远端改版。
    deps.logger.info(undefined, "go/status 里没有可用窗口", {
      providerId,
      status,
    });
    return { kind: "no-data", status };
  }
  return {
    kind: "snapshot",
    snapshot: {
      providerId,
      workspaceId,
      fetchedAt,
      windows,
      error: null,
      errorMessage: null,
    },
  };
}

/**
 * Zen 数据路线：console billing/status。鉴权、Workspace 定位、错误收敛与 Go 一致，
 * 只换端点与余额解析口径。成功但解析不出金额时返回 no-data，
 * 由调用方按 unavailable 处理（绝不当作 0 展示）。
 */
export async function fetchZenFromConsole(
  deps: UsageRouteDeps,
  providerId: string,
  credential: OpenCodeUsageCredentialRecord,
): Promise<ZenRouteOutcome> {
  const located = await resolveWorkspaceId(deps, providerId, credential);
  if (located.kind !== "workspace") return located;
  const workspaceId = located.workspaceId;

  let result: { status: number; body: string };
  try {
    result = await deps.consoleClient.request(CONSOLE_BILLING_STATUS_URL, credential.authCookie, {
      accept: "application/json",
      extraHeaders: { "x-org-id": workspaceId },
    });
  } catch {
    return { kind: "no-data", status: null };
  }
  const { status, body } = result;
  if (status === 401 || status === 403) return { kind: "auth-rejected", status };
  if (status < 200 || status >= 300) return { kind: "no-data", status };

  let parsed: ConsoleBillingStatus;
  try {
    parsed = JSON.parse(body) as ConsoleBillingStatus;
  } catch {
    deps.logger.warn(undefined, "billing/status 响应不是合法 JSON", {
      providerId,
      status,
    });
    return { kind: "no-data", status };
  }
  const fetchedAt = deps.now();
  const balances = mapBillingStatusBalance(parsed);
  if (balances.length === 0) {
    deps.logger.info(undefined, "billing/status 里没有可用余额", {
      providerId,
      status,
    });
    return { kind: "no-data", status };
  }
  return {
    kind: "snapshot",
    snapshot: {
      providerId,
      workspaceId,
      fetchedAt,
      balances,
      error: null,
      errorMessage: null,
    },
  };
}
