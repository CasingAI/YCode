import type {
  CommandCodeQuotaCredits,
  CommandCodeQuotaErrorKind,
  CommandCodeQuotaSnapshot,
  CommandCodeQuotaWindow,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

/**
 * Command Code（CommandCode.ai）套餐额度查询服务。
 *
 * 与 MiniMax 额度服务同构：查询用的就是 provider 自身 `config.access.apiKey`
 * （官方 CLI 与 Provider API 同 key），由调用方通过 `resolveApiKey` 注入，
 * 本服务不持有、不落盘任何密钥。请求只在 host 进程发出，renderer 经 RPC 代理调用，
 * 不直连 api.commandcode.ai。只认 `commandcode` 模板。
 * 产品规则见 docs/specs/commandcode-quota.md。
 */
export interface ICommandCodeQuotaService {
  getSnapshot(input: { providerId: string; refresh?: boolean }): Promise<CommandCodeQuotaSnapshot>;
}

export const ICommandCodeQuotaService = createServiceDescriptor<ICommandCodeQuotaService>(
  ServiceChannels.CommandCodeQuota,
);

export const COMMAND_CODE_API_BASE_URL = "https://api.commandcode.ai";
export const COMMAND_CODE_CREDITS_URL = `${COMMAND_CODE_API_BASE_URL}/alpha/billing/credits`;

/** 额度快照节流周期：与 MiniMax/DeepSeek/OpenCode 一致，60s 足够。 */
const SNAPSHOT_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** 响应体上限：JSON 在 KiB 量级，限制上限即可。 */
const MAX_BODY_CHARS = 4 << 20;

export interface CommandCodeQuotaServiceDependencies {
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
  snapshot: CommandCodeQuotaSnapshot;
  fetchedAt: number;
  /** 是否带可展示窗口（错误快照也可能带上一次成功的值，见 lastGood）。 */
  hasValues: boolean;
}

/** 取数结果：成功快照，或按类别收敛的失败（含状态码与面向日志的原因，不含密钥）。 */
type FetchOutcome =
  | { kind: "snapshot"; snapshot: CommandCodeQuotaSnapshot }
  | {
      kind: "error";
      error: CommandCodeQuotaErrorKind;
      status: number | null;
      message: string;
    };

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 非负有限数（金额/时间戳口径）；其余（含负数、字符串数字之外的类型）返回 null。 */
function parseAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** resetAt 毫秒时间戳 → ISO；非法时返回 null（resetAt 缺失不阻塞窗口展示）。 */
function parseResetAt(value: unknown): string | null {
  const millis = parseAmount(value);
  if (millis === null) return null;
  return new Date(millis).toISOString();
}

/** 余额单项：区分「未上报」（null）与 0，缺失的字段绝不当作 0 展示。 */
function parseCreditsField(value: unknown): number | null {
  return parseAmount(value);
}

function parseCredits(body: Record<string, unknown>): CommandCodeQuotaCredits | null {
  const credits = toRecord(body.credits);
  if (!credits) return null;
  const parsed: CommandCodeQuotaCredits = {
    monthly: parseCreditsField(credits.monthlyCredits),
    purchased: parseCreditsField(credits.purchasedCredits),
    free: parseCreditsField(credits.freeCredits),
  };
  // 三项全部未上报视为「没有余额区块」而不是「余额为 0」。
  if (parsed.monthly === null && parsed.purchased === null && parsed.free === null) return null;
  return parsed;
}

function parseWindow(
  key: CommandCodeQuotaWindow["key"],
  value: unknown,
): CommandCodeQuotaWindow | null {
  const block = toRecord(value);
  if (!block) return null;
  const used = parseAmount(block.used);
  const cap = parseAmount(block.cap);
  // cap <= 0 是官方「无上限」语义；无上限窗口不渲染（缺失处理），避免假 0%/假 100%。
  if (used === null || cap === null || cap <= 0) return null;
  return {
    key,
    used,
    cap,
    usagePercent: Math.max(0, Math.min(100, (used / cap) * 100)),
    exceeded: block.exceeded === true,
    resetAt: parseResetAt(block.resetAt),
  };
}

/**
 * 远端响应 → 额度快照数据。窗口取 `windowLimits.fiveHour/weekly`；
 * 契约为官方 CLI `/alpha/billing/credits` 实测形态、无文档背书：
 * 所有字段按缺失降级，缺失 ≠ 0；`cap <= 0` 是官方「无上限」语义，按窗口缺失处理。
 * 两个窗口都缺失时返回 null（由调用方按 `unavailable` 上报，不得当作 0%）。
 */
export function parseCommandCodeQuota(
  body: unknown,
): { windows: CommandCodeQuotaWindow[]; credits: CommandCodeQuotaCredits | null } | null {
  const root = toRecord(body);
  if (!root) return null;
  const limits = toRecord(root.windowLimits);
  const windows: CommandCodeQuotaWindow[] = [];
  const fiveHour = limits ? parseWindow("five-hour", limits.fiveHour) : null;
  if (fiveHour) windows.push(fiveHour);
  const weekly = limits ? parseWindow("weekly", limits.weekly) : null;
  if (weekly) windows.push(weekly);
  if (windows.length === 0) return null;
  return { windows, credits: parseCredits(root) };
}

export function createCommandCodeQuotaService(
  dependencies: CommandCodeQuotaServiceDependencies,
): ICommandCodeQuotaService {
  // logger 必须在工厂内创建：本模块经 @zcode/services barrel 进入 renderer bundle，
  // 顶层调用 createServiceLogger 会碰 process.pid，在浏览器环境直接 ReferenceError。
  const logger = createServiceLogger("commandcode-quota");
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  const snapshotCache = new Map<string, SnapshotCacheEntry>();
  /** 最近一次成功快照：失败时补进错误快照，保证界面不退回空白。 */
  const lastGood = new Map<string, CommandCodeQuotaSnapshot>();
  const inflightRefresh = new Map<string, Promise<void>>();

  function cacheSnapshot(providerId: string, snapshot: CommandCodeQuotaSnapshot): void {
    snapshotCache.set(providerId, {
      snapshot,
      fetchedAt: now(),
      hasValues: snapshot.windows.length > 0,
    });
  }

  /** 失败快照补上最近一次成功窗口：错误提示与旧值并存，UI 不会退回空白。 */
  function attachLastGood(
    providerId: string,
    snapshot: CommandCodeQuotaSnapshot,
  ): CommandCodeQuotaSnapshot {
    if (snapshot.error === null) return snapshot;
    const good = lastGood.get(providerId);
    if (!good) return snapshot;
    return {
      ...snapshot,
      windows: good.windows,
      credits: snapshot.credits ?? good.credits,
      fetchedAt: good.fetchedAt,
    };
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
      const response = await fetchImpl(COMMAND_CODE_CREDITS_URL, {
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

    const data = parseCommandCodeQuota(parsed);
    if (!data) {
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
        fetchedAt: now(),
        windows: data.windows,
        credits: data.credits,
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
    snapshot: CommandCodeQuotaSnapshot,
  ): CommandCodeQuotaSnapshot {
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
  async function fetchSnapshot(providerId: string): Promise<CommandCodeQuotaSnapshot> {
    const apiKey = (await dependencies.resolveApiKey(providerId))?.trim() ?? "";
    if (!apiKey) {
      // 没有可用 API Key：展示值不再可信，连同 last-good 一起清掉。
      forget(providerId);
      const snapshot: CommandCodeQuotaSnapshot = {
        providerId,
        fetchedAt: now(),
        windows: [],
        credits: null,
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
      credits: null,
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
    async getSnapshot({ providerId, refresh }): Promise<CommandCodeQuotaSnapshot> {
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
