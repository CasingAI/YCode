import type { OpenCodeUsageSnapshot, OpenCodeZenBalanceSnapshot } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  type ConsoleBillingStatus,
  type GoUsageResponse,
  type OpenCodeConsoleClient,
  mapBillingStatusBalance,
  mapGoUsageWindows,
} from "./opencodeConsoleApi.js";

/** Go 取数结果：401=API Key 被拒，403=无 Go 订阅；no-data 带状态码。 */
export type UsageRouteOutcome =
  | { kind: "snapshot"; snapshot: OpenCodeUsageSnapshot }
  | { kind: "auth-rejected"; status: number }
  | { kind: "subscription-required"; status: 403 }
  | { kind: "no-data"; status: number | null };

export type ZenRouteOutcome =
  | { kind: "snapshot"; snapshot: OpenCodeZenBalanceSnapshot }
  | { kind: "auth-rejected"; status: number }
  | { kind: "no-data"; status: number | null };

export interface UsageRouteDeps {
  consoleClient: OpenCodeConsoleClient;
  logger: ServiceLogger;
  now: () => number;
}

/** Go 套餐走 API Key 认证的用量接口；不依赖 Cookie 或 Workspace。 */
export async function fetchGoUsage(
  deps: UsageRouteDeps,
  providerId: string,
  apiKey: string,
): Promise<UsageRouteOutcome> {
  let result: { status: number; body: string };
  try {
    result = await deps.consoleClient.fetchGoUsage(apiKey);
  } catch {
    return { kind: "no-data", status: null };
  }
  const { status, body } = result;
  if (status === 401) return { kind: "auth-rejected", status };
  if (status === 403) return { kind: "subscription-required", status };
  if (status < 200 || status >= 300) return { kind: "no-data", status };

  let parsed: GoUsageResponse;
  try {
    parsed = JSON.parse(body) as GoUsageResponse;
  } catch {
    deps.logger.warn(undefined, "Go usage 响应不是合法 JSON", { providerId, status });
    return { kind: "no-data", status };
  }
  const fetchedAt = deps.now();
  const windows = mapGoUsageWindows(parsed, fetchedAt);
  if (windows.length === 0) {
    deps.logger.info(undefined, "Go usage 响应里没有可用窗口", { providerId, status });
    return { kind: "no-data", status: 200 };
  }
  return {
    kind: "snapshot",
    snapshot: {
      providerId,
      fetchedAt,
      windows,
      error: null,
      errorMessage: null,
    },
  };
}

/**
 * Zen 余额使用 Provider 已配置的 API Key 调用 Console billing/status。
 * 实测该接口接受 Bearer Key，无需 Cookie、org/workspace header 或浏览器会话。
 */
export async function fetchZenFromConsole(
  deps: UsageRouteDeps,
  providerId: string,
  apiKey: string,
): Promise<ZenRouteOutcome> {
  let result: { status: number; body: string };
  try {
    result = await deps.consoleClient.fetchZenBalance(apiKey);
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
    deps.logger.warn(undefined, "billing/status 响应不是合法 JSON", { providerId, status });
    return { kind: "no-data", status };
  }
  const fetchedAt = deps.now();
  const balances = mapBillingStatusBalance(parsed);
  if (balances.length === 0) {
    deps.logger.info(undefined, "billing/status 里没有可用余额", { providerId, status });
    return { kind: "no-data", status: 200 };
  }
  return {
    kind: "snapshot",
    snapshot: {
      providerId,
      fetchedAt,
      balances,
      error: null,
      errorMessage: null,
    },
  };
}
