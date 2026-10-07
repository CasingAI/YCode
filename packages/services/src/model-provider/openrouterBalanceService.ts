import type { OpenRouterBalanceErrorKind, OpenRouterBalanceSnapshot } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

/**
 * OpenRouter 账户余额查询服务。
 *
 * 与 DeepSeek 余额服务同构：查询用的就是 provider 自身 `config.access.apiKey`，
 * 由调用方通过 `resolveApiKey` 注入，本服务不持有、不落盘任何密钥。
 * 请求只在 host 进程发出，renderer 经 RPC 代理调用，不直连 openrouter.ai。
 * 剩余额度 = total_credits - total_usage，由 host 侧计算后写入快照。
 * 产品规则见 docs/specs/openrouter-balance.md。
 */
export interface IOpenRouterBalanceService {
  getSnapshot(input: { providerId: string; refresh?: boolean }): Promise<OpenRouterBalanceSnapshot>;
}

export const IOpenRouterBalanceService = createServiceDescriptor<IOpenRouterBalanceService>(
  ServiceChannels.OpenRouterBalance,
);

export const OPENROUTER_BASE_URL = "https://openrouter.ai";
export const OPENROUTER_CREDITS_URL = `${OPENROUTER_BASE_URL}/api/v1/credits`;

/** 余额快照节流周期：与 DeepSeek 一致，60s 足够。 */
const SNAPSHOT_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** 响应体上限：JSON 在 KiB 量级，限制上限即可。 */
const MAX_BODY_CHARS = 4 << 20;

export interface OpenRouterBalanceServiceDependencies {
  /**
   * 按 providerId 读该 provider 已配置的 API Key；未配置或非 api-key 接入返回 null
   * （调用方按 `not-configured` 处理，不发请求）。实现方在装配层从 provider 配置读，
   * 本服务不依赖 provider Registry。
   */
  resolveApiKey: (providerId: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface SnapshotCacheEntry {
  snapshot: OpenRouterBalanceSnapshot;
  fetchedAt: number;
  /** 是否带可展示金额（错误快照也可能带上一次成功的值，见 lastGood）。 */
  hasValues: boolean;
}

/** 远端 data 对象：两个金额可能是数字，也可能是十进制字符串。 */
interface RawCreditsData {
  total_credits?: unknown;
  total_usage?: unknown;
}

interface RawCreditsResponse {
  data?: unknown;
}

/** 取数结果：成功快照，或按类别收敛的失败（含状态码与面向日志的原因，不含密钥）。 */
type FetchOutcome =
  | { kind: "snapshot"; snapshot: OpenRouterBalanceSnapshot }
  | {
      kind: "error";
      error: OpenRouterBalanceErrorKind;
      status: number | null;
      message: string;
    };

/** 金额是数字或十进制字符串；解析不出有限数值时返回 null，绝不当作 0 展示。 */
function parseAmount(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 远端响应 → 余额三元组。`data.total_credits` / `data.total_usage` 任一缺失时
 * 返回 null，由调用方按 unavailable 上报（不得当作 0 展示）。
 */
export function parseOpenRouterCredits(body: unknown): {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
} | null {
  const data = (body as RawCreditsResponse | null)?.data as RawCreditsData | null;
  if (!data || typeof data !== "object") return null;
  const totalCredits = parseAmount(data.total_credits);
  const totalUsage = parseAmount(data.total_usage);
  if (totalCredits === null || totalUsage === null) return null;
  return { totalCredits, totalUsage, remaining: totalCredits - totalUsage };
}

export function createOpenRouterBalanceService(
  dependencies: OpenRouterBalanceServiceDependencies,
): IOpenRouterBalanceService {
  // logger 必须在工厂内创建：本模块经 @zcode/services barrel 进入 renderer bundle，
  // 顶层调用 createServiceLogger 会碰 process.pid，在浏览器环境直接 ReferenceError。
  const logger = createServiceLogger("openrouter-balance");
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  const snapshotCache = new Map<string, SnapshotCacheEntry>();
  /** 最近一次成功快照：失败时补进错误快照，保证界面不退回空白。 */
  const lastGood = new Map<string, OpenRouterBalanceSnapshot>();
  const inflightRefresh = new Map<string, Promise<void>>();

  function cacheSnapshot(providerId: string, snapshot: OpenRouterBalanceSnapshot): void {
    snapshotCache.set(providerId, {
      snapshot,
      fetchedAt: now(),
      hasValues: snapshot.remaining !== null,
    });
  }

  /** 失败快照补上最近一次成功金额：错误提示与旧值并存，UI 不会退回空白。 */
  function attachLastGood(
    providerId: string,
    snapshot: OpenRouterBalanceSnapshot,
  ): OpenRouterBalanceSnapshot {
    if (snapshot.error === null) return snapshot;
    const good = lastGood.get(providerId);
    if (!good) return snapshot;
    return {
      ...snapshot,
      totalCredits: good.totalCredits,
      totalUsage: good.totalUsage,
      remaining: good.remaining,
      fetchedAt: good.fetchedAt,
    };
  }

  /** 余额已不可信（provider 删了 / key 清了）：连同 last-good 一起清掉。 */
  function forget(providerId: string): void {
    snapshotCache.delete(providerId);
    lastGood.delete(providerId);
  }

  async function fetchBalance(providerId: string, apiKey: string): Promise<FetchOutcome> {
    let status: number;
    let body: string;
    try {
      const response = await fetchImpl(OPENROUTER_CREDITS_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      body = (await response.text()).slice(0, MAX_BODY_CHARS);
    } catch {
      return {
        kind: "error",
        error: "unavailable",
        status: null,
        message: "balance request failed",
      };
    }

    if (status === 401 || status === 403) {
      return {
        kind: "error",
        error: "credential-stale",
        status,
        message: `balance request was rejected (HTTP ${status})`,
      };
    }
    if (status < 200 || status >= 300) {
      return {
        kind: "error",
        error: "unavailable",
        status,
        message: `balance responded with HTTP ${status}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        kind: "error",
        error: "unavailable",
        status,
        message: "balance response is not valid JSON",
      };
    }

    const credits = parseOpenRouterCredits(parsed);
    if (!credits) {
      return {
        kind: "error",
        error: "unavailable",
        status,
        message: "balance response has no credit entry",
      };
    }
    return {
      kind: "snapshot",
      snapshot: {
        providerId,
        fetchedAt: now(),
        totalCredits: credits.totalCredits,
        totalUsage: credits.totalUsage,
        remaining: credits.remaining,
        error: null,
        errorMessage: null,
      },
    };
  }

  /**
   * 落地一次取数结果：成功快照记入 last-good，失败快照补上最近一次金额后写入节流缓存。
   * 失败必须保留旧金额，否则界面会在「有数/没数」之间来回跳。
   */
  function finishWithSnapshot(
    providerId: string,
    snapshot: OpenRouterBalanceSnapshot,
  ): OpenRouterBalanceSnapshot {
    if (snapshot.error !== null) {
      const result = attachLastGood(providerId, snapshot);
      cacheSnapshot(providerId, result);
      return result;
    }
    lastGood.set(providerId, snapshot);
    logger.info(undefined, "余额已更新", {
      providerId,
      remaining: snapshot.remaining,
    });
    cacheSnapshot(providerId, snapshot);
    return snapshot;
  }

  /** 拉取并解析余额，写入节流缓存；失败不覆盖 last-good，错误由返回值承载。 */
  async function fetchSnapshot(providerId: string): Promise<OpenRouterBalanceSnapshot> {
    const apiKey = (await dependencies.resolveApiKey(providerId))?.trim() ?? "";
    if (!apiKey) {
      // 没有可用 API Key：展示值不再可信，连同 last-good 一起清掉。
      forget(providerId);
      const snapshot: OpenRouterBalanceSnapshot = {
        providerId,
        fetchedAt: now(),
        totalCredits: null,
        totalUsage: null,
        remaining: null,
        error: "not-configured",
        errorMessage: null,
      };
      cacheSnapshot(providerId, snapshot);
      return snapshot;
    }

    const outcome = await fetchBalance(providerId, apiKey);
    if (outcome.kind === "snapshot") return finishWithSnapshot(providerId, outcome.snapshot);

    logger.warn(undefined, "余额查询失败", {
      providerId,
      error: outcome.error,
      status: outcome.status,
      message: outcome.message,
    });
    return finishWithSnapshot(providerId, {
      providerId,
      fetchedAt: now(),
      totalCredits: null,
      totalUsage: null,
      remaining: null,
      error: outcome.error,
      // 只带状态码与失败原因，绝不带 API Key。
      errorMessage: outcome.message,
    });
  }

  /**
   * 后台刷新（stale-while-revalidate 的 refresh 半边）：去重防并发重复请求，
   * 完成后更新节流缓存，下一次 getSnapshot 即可拿到新值。
   */
  function triggerBackgroundRefresh(providerId: string): void {
    if (inflightRefresh.has(providerId)) return;
    const task = (async () => {
      try {
        await fetchSnapshot(providerId);
      } catch {
        // 后台刷新失败静默：节流缓存保留 last-good，由下一次调用重试。
      } finally {
        inflightRefresh.delete(providerId);
      }
    })();
    inflightRefresh.set(providerId, task);
  }

  return {
    async getSnapshot({ providerId, refresh }): Promise<OpenRouterBalanceSnapshot> {
      const cached = snapshotCache.get(providerId);
      if (!refresh && cached) {
        if (now() - cached.fetchedAt < SNAPSHOT_TTL_MS) {
          return cached.snapshot;
        }
        if (cached.hasValues) {
          // 过期但有展示值（含「失败 + 旧值」形态）立即返回，刷新转后台：
          // 界面永远先出数字，不给用户看空白。
          triggerBackgroundRefresh(providerId);
          return cached.snapshot;
        }
      }
      return fetchSnapshot(providerId);
    },
  };
}
