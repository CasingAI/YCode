import type {
  MiniMaxQuotaErrorKind,
  MiniMaxQuotaSnapshot,
  MiniMaxQuotaWindow,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

/**
 * MiniMax Token Plan 套餐额度查询服务。
 *
 * 与 DeepSeek 余额服务同构：查询用的就是 provider 自身 `config.access.apiKey`
 *（订阅 Key），由调用方通过 `resolveApiKey` 注入，本服务不持有、不落盘任何密钥。
 * 请求只在 host 进程发出，renderer 经 RPC 代理调用，不直连 api.minimaxi.com。
 * 只认 `minimax-token-plan` 模板的订阅 Key，不认普通平台 key。
 * 产品规则见 docs/specs/minimax-quota.md。
 */
export interface IMiniMaxQuotaService {
  getSnapshot(input: { providerId: string; refresh?: boolean }): Promise<MiniMaxQuotaSnapshot>;
}

export const IMiniMaxQuotaService = createServiceDescriptor<IMiniMaxQuotaService>(
  ServiceChannels.MiniMaxQuota,
);

export const MINIMAX_BASE_URL = "https://api.minimaxi.com";
export const MINIMAX_TOKEN_PLAN_REMAINS_URL = `${MINIMAX_BASE_URL}/v1/token_plan/remains`;

/** 额度快照节流周期：与 DeepSeek/OpenCode 一致，60s 足够。 */
const SNAPSHOT_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** 响应体上限：JSON 在 KiB 量级，限制上限即可。 */
const MAX_BODY_CHARS = 4 << 20;
/** 周额度 boost 展示上限：对齐官方 CLI `MAX_DISPLAY_PCT = 200`。 */
const MAX_DISPLAY_PERCENT = 200;
/** 编程额度桶：数组会混入 video 等非编程模型条目，只取 general。 */
const PROGRAMMING_MODEL_NAME = "general";

export interface MiniMaxQuotaServiceDependencies {
  /**
   * 按 providerId 读该 provider 已配置的订阅 Key；未配置或非 api-key 接入返回 null
   * （调用方按 `not-configured` 处理，不发请求）。实现方在装配层从 provider 配置读，
   * 本服务不依赖 provider Registry。
   */
  resolveApiKey: (providerId: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface SnapshotCacheEntry {
  snapshot: MiniMaxQuotaSnapshot;
  fetchedAt: number;
  /** 是否带可展示窗口（错误快照也可能带上一次成功的值，见 lastGood）。 */
  hasValues: boolean;
}

/** 远端 model_remains 条目：percent 与 count 口径都可能出现，只信 percent。 */
interface RawModelRemain {
  model_name?: unknown;
  current_interval_remaining_percent?: unknown;
  current_weekly_remaining_percent?: unknown;
  remains_time?: unknown;
  weekly_remains_time?: unknown;
  current_interval_status?: unknown;
  current_weekly_status?: unknown;
  weekly_boost_permille?: unknown;
}

interface RawRemainsResponse {
  model_remains?: unknown;
}

/** 取数结果：成功快照，或按类别收敛的失败（含状态码与面向日志的原因，不含密钥）。 */
type FetchOutcome =
  | { kind: "snapshot"; snapshot: MiniMaxQuotaSnapshot }
  | {
      kind: "error";
      error: MiniMaxQuotaErrorKind;
      status: number | null;
      message: string;
    };

/** percent 是 0–100 的数字（远端也可能是十进制字符串）；非法时返回 null。 */
function parsePercent(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 100) return null;
  return parsed;
}

function parseStatus(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** remains_time 是毫秒数；非法时返回 null（resetAt 缺失不阻塞窗口展示）。 */
function parseResetAt(value: unknown, fetchedAtMs: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis < 0) return null;
  return new Date(fetchedAtMs + millis).toISOString();
}

function parseBoostPermille(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * 远端响应 → 额度窗口。只取 `model_name === "general"` 的编程桶，最多两条
 * （interval + weekly）；`*_count` 系列已知语义反转，直接忽略。
 * status === 3 的窗口标记「不在套餐内」，由展示端决定不渲染百分比。
 */
export function parseMiniMaxQuotaWindows(body: unknown, fetchedAtMs: number): MiniMaxQuotaWindow[] {
  const raw = (body as RawRemainsResponse | null)?.model_remains;
  if (!Array.isArray(raw)) return [];
  const general = (raw as RawModelRemain[]).find(
    (entry) => entry?.model_name === PROGRAMMING_MODEL_NAME,
  );
  if (!general) return [];
  // weekly_boost_permille 是千分比放大因子（如 1500 ⇒ 展示到 150%），钳到 200%。
  const boost = parseBoostPermille(general.weekly_boost_permille) ?? 1000;
  const windows: MiniMaxQuotaWindow[] = [];
  const intervalPercent = parsePercent(general.current_interval_remaining_percent);
  if (intervalPercent !== null) {
    windows.push({
      key: "interval",
      remainingPercent: intervalPercent,
      resetAt: parseResetAt(general.remains_time, fetchedAtMs),
      status: parseStatus(general.current_interval_status),
    });
  }
  const weeklyPercent = parsePercent(general.current_weekly_remaining_percent);
  if (weeklyPercent !== null) {
    windows.push({
      key: "weekly",
      remainingPercent: Math.min(MAX_DISPLAY_PERCENT, (weeklyPercent * boost) / 1000),
      resetAt: parseResetAt(general.weekly_remains_time, fetchedAtMs),
      status: parseStatus(general.current_weekly_status),
    });
  }
  return windows;
}

export function createMiniMaxQuotaService(
  dependencies: MiniMaxQuotaServiceDependencies,
): IMiniMaxQuotaService {
  // logger 必须在工厂内创建：本模块经 @zcode/services barrel 进入 renderer bundle，
  // 顶层调用 createServiceLogger 会碰 process.pid，在浏览器环境直接 ReferenceError。
  const logger = createServiceLogger("minimax-quota");
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  const snapshotCache = new Map<string, SnapshotCacheEntry>();
  /** 最近一次成功快照：失败时补进错误快照，保证界面不退回空白。 */
  const lastGood = new Map<string, MiniMaxQuotaSnapshot>();
  const inflightRefresh = new Map<string, Promise<void>>();

  function cacheSnapshot(providerId: string, snapshot: MiniMaxQuotaSnapshot): void {
    snapshotCache.set(providerId, {
      snapshot,
      fetchedAt: now(),
      hasValues: snapshot.windows.length > 0,
    });
  }

  /** 失败快照补上最近一次成功窗口：错误提示与旧值并存，UI 不会退回空白。 */
  function attachLastGood(
    providerId: string,
    snapshot: MiniMaxQuotaSnapshot,
  ): MiniMaxQuotaSnapshot {
    if (snapshot.error === null) return snapshot;
    const good = lastGood.get(providerId);
    if (!good) return snapshot;
    return { ...snapshot, windows: good.windows, fetchedAt: good.fetchedAt };
  }

  /** 额度已不可信（provider 删了 / key 清了）：连同 last-good 一起清掉。 */
  function forget(providerId: string): void {
    snapshotCache.delete(providerId);
    lastGood.delete(providerId);
  }

  async function fetchQuota(providerId: string, apiKey: string): Promise<FetchOutcome> {
    let status: number;
    let body: string;
    try {
      const response = await fetchImpl(MINIMAX_TOKEN_PLAN_REMAINS_URL, {
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
        message: "quota request failed",
      };
    }

    if (status === 401 || status === 403) {
      return {
        kind: "error",
        error: "credential-stale",
        status,
        message: `quota request was rejected (HTTP ${status})`,
      };
    }
    if (status < 200 || status >= 300) {
      return {
        kind: "error",
        error: "unavailable",
        status,
        message: `quota responded with HTTP ${status}`,
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
        message: "quota response is not valid JSON",
      };
    }

    const fetchedAt = now();
    const windows = parseMiniMaxQuotaWindows(parsed, fetchedAt);
    if (windows.length === 0) {
      return {
        kind: "error",
        error: "unavailable",
        status,
        message: "quota response has no usable window",
      };
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
   * 落地一次取数结果：成功快照记入 last-good，失败快照补上最近一次窗口后写入节流缓存。
   * 失败必须保留旧窗口，否则界面会在「有数/没数」之间来回跳。
   */
  function finishWithSnapshot(
    providerId: string,
    snapshot: MiniMaxQuotaSnapshot,
  ): MiniMaxQuotaSnapshot {
    if (snapshot.error !== null) {
      const result = attachLastGood(providerId, snapshot);
      cacheSnapshot(providerId, result);
      return result;
    }
    lastGood.set(providerId, snapshot);
    logger.info(undefined, "额度已更新", {
      providerId,
      windows: snapshot.windows.map((entry) => entry.key),
    });
    cacheSnapshot(providerId, snapshot);
    return snapshot;
  }

  /** 拉取并解析额度，写入节流缓存；失败不覆盖 last-good，错误由返回值承载。 */
  async function fetchSnapshot(providerId: string): Promise<MiniMaxQuotaSnapshot> {
    const apiKey = (await dependencies.resolveApiKey(providerId))?.trim() ?? "";
    if (!apiKey) {
      // 没有可用订阅 Key：展示值不再可信，连同 last-good 一起清掉。
      forget(providerId);
      const snapshot: MiniMaxQuotaSnapshot = {
        providerId,
        fetchedAt: now(),
        windows: [],
        error: "not-configured",
        errorMessage: null,
      };
      cacheSnapshot(providerId, snapshot);
      return snapshot;
    }

    const outcome = await fetchQuota(providerId, apiKey);
    if (outcome.kind === "snapshot") return finishWithSnapshot(providerId, outcome.snapshot);

    logger.warn(undefined, "额度查询失败", {
      providerId,
      error: outcome.error,
      status: outcome.status,
      message: outcome.message,
    });
    return finishWithSnapshot(providerId, {
      providerId,
      fetchedAt: now(),
      windows: [],
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
    async getSnapshot({ providerId, refresh }): Promise<MiniMaxQuotaSnapshot> {
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
