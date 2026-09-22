import { ServiceChannels } from "@zcode/shared";
import type {
  OpenCodeUsageCredentialHint,
  OpenCodeUsageCredentialInput,
  OpenCodeUsageErrorKind,
  OpenCodeUsageSnapshot,
  OpenCodeWorkspaceList,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { ConsoleGoStatus } from "./opencodeConsoleApi.js";
import {
  CONSOLE_GO_STATUS_URL,
  createOpenCodeConsoleClient,
  mapGoStatusWindows,
  normalizeOpencodeCookieHeader,
  normalizeOpencodeWorkspaceId,
} from "./opencodeConsoleApi.js";

/**
 * OpenCode 套餐用量查询服务。
 *
 * 凭据（完整 Cookie 请求头，管用的是其中的 `__Host-console_session` + 所选 Workspace ID）
 * 唯一持久化在 ICredentialService（host 进程），key 为 `opencode-usage:<providerId>`；
 * 快照只是 60s TTL 的内存派生缓存。请求只在 host 进程发出，renderer 经 RPC 代理调用，
 * 不直连 opencode.ai。
 *
 * 2026-09-22 实测：opencode.ai 主站登录体系已下线（`/auth`、`/workspace/<id>/go` 一律
 * 302 到 `/console/login`），数据路线整体切换为 console JSON API（见下方两个 URL 常量）。
 */
export interface IOpenCodeUsageService {
  getSnapshot(input: { providerId: string; refresh?: boolean }): Promise<OpenCodeUsageSnapshot>;
  saveCredential(input: OpenCodeUsageCredentialInput): Promise<void>;
  /**
   * 拉 Workspace 下拉列表。`authCookie` 非空时用草稿归一化后请求（用户还没点保存）；
   * 为空且已配置则用已保存凭据；两者皆无返回空列表、error=null。
   */
  listWorkspaces(input: { providerId: string; authCookie: string }): Promise<OpenCodeWorkspaceList>;
  clearCredential(input: { providerId: string }): Promise<void>;
  getCredentialHint(input: { providerId: string }): Promise<OpenCodeUsageCredentialHint | null>;
}

export const IOpenCodeUsageService = createServiceDescriptor<IOpenCodeUsageService>(
  ServiceChannels.OpenCodeUsage,
);

const CREDENTIAL_KEY_PREFIX = "opencode-usage:";
const SNAPSHOT_TTL_MS = 60_000;

interface OpenCodeUsageCredentialRecord {
  /** 用户粘贴并归一化后的凭据（原始 token / Cookie 头，原样透传）。 */
  authCookie: string;
  workspaceId: string;
  savedAt: number;
}

interface SnapshotCacheEntry {
  snapshot: OpenCodeUsageSnapshot;
  fetchedAt: number;
  /**
   * 是否带可展示的窗口值。错误快照也会带上一次成功的窗口（见 lastGood），
   * 这种条目同样可以让 UI 立即出数，只是同时提示错误。
   */
  hasValues: boolean;
}

/** 取数结果：auth-rejected=远端明确拒绝（401/403）；no-data 带状态码（拿不到响应为 null）。 */
type RouteOutcome =
  | { kind: "snapshot"; snapshot: OpenCodeUsageSnapshot }
  | { kind: "auth-rejected"; status: number }
  | { kind: "no-data"; status: number | null };

export interface OpenCodeUsageServiceDependencies {
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function credentialKey(providerId: string): string {
  return `${CREDENTIAL_KEY_PREFIX}${providerId}`;
}

function emptySnapshot(providerId: string, now: number): OpenCodeUsageSnapshot {
  return {
    providerId,
    workspaceId: null,
    fetchedAt: now,
    windows: [],
    error: null,
    errorMessage: null,
  };
}

export function createOpenCodeUsageService(
  dependencies: OpenCodeUsageServiceDependencies,
): IOpenCodeUsageService {
  // logger 必须在工厂内创建：本模块经 @zcode/services barrel 进入 renderer bundle，
  // 顶层调用 createServiceLogger 会碰 process.pid，在浏览器环境直接 ReferenceError。
  const logger = createServiceLogger("opencode-usage");
  const now = dependencies.now ?? Date.now;
  const { credentialService } = dependencies;
  // console 侧 HTTP（请求、orgs 解析、列表缓存）下沉到独立 client，本服务只留状态所有权。
  const consoleClient = createOpenCodeConsoleClient(dependencies);
  /**
   * 最近一次结果（成功或失败），用于 60s 请求节流；失败结果 TTL 过期后重试。
   * lastGood 单独存最近一次成功快照（从缓存条目里分出来）：失败会覆盖缓存条目，
   * 但不能连展示值一起丢掉——否则 Composer 浮层每次重新展开（HoverCard 关闭即卸载）
   * 都要等一次网络往返才出数字，表现为「时而有时而没有」。
   */
  const snapshotCache = new Map<string, SnapshotCacheEntry>();
  const lastGood = new Map<string, OpenCodeUsageSnapshot>();
  /**
   * 已知该凭据读不了用量（401）的凭据标记（savedAt）。
   * 每次刷新都白打一发会让等待多出 0.3–1.5s，且结论不会变（凭据没换就还是被拒）。
   * 换凭据（savedAt 变化）或换 workspace 即失效。
   * 只记 401：403 可能是 Cloudflare 之类的暂时性拒绝，不能据此长期跳过请求。
   */
  const staleCredential = new Map<string, number>();
  /** 自动定位的默认 Workspace id（savedAt 变化即失效），避免每次刷新都拉一遍列表。 */
  const workspaceIdCache = new Map<string, { savedAt: number; workspaceId: string }>();
  const inflightRefresh = new Map<string, Promise<void>>();

  function cacheSnapshot(providerId: string, snapshot: OpenCodeUsageSnapshot): void {
    snapshotCache.set(providerId, {
      snapshot,
      fetchedAt: now(),
      hasValues: snapshot.windows.length > 0,
    });
  }

  /** 失败快照补上最近一次成功窗口：错误提示与旧值并存，UI 不会退回空白。 */
  function attachLastGood(
    providerId: string,
    snapshot: OpenCodeUsageSnapshot,
  ): OpenCodeUsageSnapshot {
    if (snapshot.error === null) return snapshot;
    const good = lastGood.get(providerId);
    if (!good) return snapshot;
    return { ...snapshot, windows: good.windows, fetchedAt: good.fetchedAt };
  }

  function forget(providerId: string): void {
    snapshotCache.delete(providerId);
    lastGood.delete(providerId);
    staleCredential.delete(providerId);
    workspaceIdCache.delete(providerId);
  }

  async function loadCredential(providerId: string): Promise<OpenCodeUsageCredentialRecord | null> {
    const raw = await credentialService.load(credentialKey(providerId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as OpenCodeUsageCredentialRecord;
      if (!parsed?.authCookie) return null;
      // workspaceId 允许是空串：空 = 自动定位默认 Workspace（见 resolveWorkspaceId）。
      return { ...parsed, workspaceId: parsed.workspaceId ?? "" };
    } catch {
      logger.warn(undefined, "凭据记录损坏，按未配置处理", { providerId });
      return null;
    }
  }

  /**
   * 解析出本次请求用的 Cookie：草稿非空用草稿（归一化），否则用已保存凭据。
   * 两者皆无返回 null（调用方按「还没有可用凭据」处理，不发请求）。
   */
  async function resolveCookie(
    providerId: string,
    authCookieDraft: string,
  ): Promise<{ cookie: string; savedAt: number } | null> {
    const draft = authCookieDraft.trim();
    if (draft) {
      const normalized = normalizeOpencodeCookieHeader(draft);
      return normalized ? { cookie: normalized, savedAt: 0 } : null;
    }
    const credential = await loadCredential(providerId);
    return credential ? { cookie: credential.authCookie, savedAt: credential.savedAt } : null;
  }

  /**
   * 定位要读的那个 Workspace：显式选了就用选的，留空则取 Workspace 列表的第一个
   * `wrk_` 条目（console 把默认 Workspace 排在首位，实测如此）。结果按凭据缓存在
   * 内存（同一次会话里默认 Workspace 不变），免得每次刷新都多打一发。
   *
   * Cookie 失效时列表请求 401，返回 auth-rejected 交给调用方按需要重配上报。
   */
  async function resolveWorkspaceId(
    providerId: string,
    credential: OpenCodeUsageCredentialRecord,
  ): Promise<
    | { kind: "workspace"; workspaceId: string }
    | { kind: "auth-rejected"; status: number }
    | { kind: "no-data"; status: number | null }
  > {
    if (credential.workspaceId) return { kind: "workspace", workspaceId: credential.workspaceId };
    const cached = workspaceIdCache.get(providerId);
    if (cached && cached.savedAt === credential.savedAt) {
      return { kind: "workspace", workspaceId: cached.workspaceId };
    }

    const list = await consoleClient.fetchWorkspaceList(credential.authCookie);
    if (list.kind === "error") {
      logger.info(undefined, "未能从 orgs 列表定位默认 Workspace", {
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
      logger.info(undefined, "orgs 列表里没有 wrk_ workspace", { providerId });
      return { kind: "no-data", status: 200 };
    }
    workspaceIdCache.set(providerId, {
      savedAt: credential.savedAt,
      workspaceId: first.id,
    });
    return { kind: "workspace", workspaceId: first.id };
  }

  /**
   * 唯一数据路线：console go/status。请求成功但没有可用窗口时返回 no-data，
   * 由调用方按 unavailable 处理（绝不当作 0% 展示）。
   */
  async function fetchFromConsole(
    providerId: string,
    credential: OpenCodeUsageCredentialRecord,
  ): Promise<RouteOutcome> {
    const located = await resolveWorkspaceId(providerId, credential);
    if (located.kind !== "workspace") return located;
    const workspaceId = located.workspaceId;

    let result: { status: number; body: string };
    try {
      result = await consoleClient.request(CONSOLE_GO_STATUS_URL, credential.authCookie, {
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
      logger.warn(undefined, "go/status 响应不是合法 JSON", {
        providerId,
        status,
      });
      return { kind: "no-data", status };
    }
    const fetchedAt = now();
    const windows = mapGoStatusWindows(parsed, fetchedAt);
    if (windows.length === 0) {
      // 200 却没有窗口：要么该 workspace 没启用 Go 套餐（正常），要么远端改版。
      logger.info(undefined, "go/status 里没有可用窗口", {
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

  /** 拉取并解析用量，写入节流缓存；失败不覆盖 last-good，错误由返回值承载。 */
  async function fetchSnapshot(providerId: string): Promise<OpenCodeUsageSnapshot> {
    const credential = await loadCredential(providerId);
    if (!credential) {
      // 凭据已不存在：展示值不再可信，连同 last-good 一起清掉。
      forget(providerId);
      const snapshot: OpenCodeUsageSnapshot = {
        ...emptySnapshot(providerId, now()),
        error: "not-configured",
      };
      cacheSnapshot(providerId, snapshot);
      return snapshot;
    }

    // 该凭据已确认读不了用量时不再重复发请求（省 0.3–1.5s/次，也少一次无谓的远端请求）；
    // 换凭据（savedAt 变化）即重新探测。
    const knownRejected = staleCredential.get(providerId) === credential.savedAt;
    let status: number | null = knownRejected ? 401 : null;
    if (!knownRejected) {
      const outcome = await fetchFromConsole(providerId, credential);
      if (outcome.kind === "snapshot") {
        return finishWithSnapshot(providerId, outcome.snapshot);
      }
      status = outcome.status;
      if (outcome.kind === "auth-rejected" && outcome.status === 401) {
        staleCredential.set(providerId, credential.savedAt);
      }
    }

    // 401/403 都表示「这次访问没有被认可」（console 会话失效），属于「重试不会变好」，
    // 需要用户改配置。
    if (status !== null && (status === 401 || status === 403)) {
      logger.warn(undefined, "console 拒绝了该凭据", { providerId, status });
      const snapshot: OpenCodeUsageSnapshot = {
        ...emptySnapshot(providerId, now()),
        workspaceId: credential.workspaceId || null,
        error: "credential-stale",
        errorMessage: `opencode.ai did not authorise the request (HTTP ${status})`,
      };
      return finishWithSnapshot(providerId, snapshot);
    }

    // 其余情况是暂时故障/远端改版：状态码入日志，便于区分 5xx 与零窗口。
    logger.info(undefined, "用量未取到", { providerId, status });
    const snapshot: OpenCodeUsageSnapshot = {
      ...emptySnapshot(providerId, now()),
      workspaceId: credential.workspaceId || null,
      error: "unavailable",
      errorMessage: "go/status returned no windows",
    };
    return finishWithSnapshot(providerId, snapshot);
  }

  /**
   * 落地一次取数结果：成功快照记入 last-good，失败快照补上最近一次成功窗口后写入
   * 节流缓存。失败必须保留旧窗口，否则界面会在「有数/没数」之间来回跳。
   */
  function finishWithSnapshot(
    providerId: string,
    snapshot: OpenCodeUsageSnapshot,
  ): OpenCodeUsageSnapshot {
    if (snapshot.error !== null) {
      const result = attachLastGood(providerId, snapshot);
      cacheSnapshot(providerId, result);
      warnSnapshotError(providerId, result);
      return result;
    }

    if (snapshot.windows.length > 0) {
      lastGood.set(providerId, snapshot);
      // 只记窗口 key 与已用百分比（非凭据信息）：窗口缺失时可据此区分是远端只回了
      // 部分窗口，还是展示端的问题。
      logger.info(undefined, "用量已更新", {
        providerId,
        windows: snapshot.windows.map((window) => window.key),
        usagePercent: snapshot.windows.map((window) => Math.round(window.usagePercent)),
      });
    }
    cacheSnapshot(providerId, snapshot);
    return snapshot;
  }

  /** 统一的失败日志：warn 级别（用量查询失败不影响会话，可恢复），消息不含凭据。 */
  function warnSnapshotError(providerId: string, snapshot: OpenCodeUsageSnapshot): void {
    if (!snapshot.error) return;
    logger.warn(undefined, "用量查询失败", {
      providerId,
      errorKind: snapshot.error satisfies OpenCodeUsageErrorKind,
      message: snapshot.errorMessage,
    });
  }

  /**
   * 后台刷新（stale-while-revalidate 的 refresh 半边）：去重防并发重复 GET，
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
    async getSnapshot({ providerId, refresh }): Promise<OpenCodeUsageSnapshot> {
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

      const snapshot = await fetchSnapshot(providerId);
      return snapshot;
    },

    async listWorkspaces({ providerId, authCookie }): Promise<OpenCodeWorkspaceList> {
      const resolved = await resolveCookie(providerId, authCookie);
      if (!resolved) return { workspaces: [], error: null };
      // 列表缓存（按 Cookie 串 60s TTL + in-flight 去重）在 console client 内部。
      const list = await consoleClient.listWorkspaces(resolved.cookie);
      if (list.error) {
        logger.warn(undefined, "Workspace 列表拉取失败", {
          providerId,
          error: list.error,
        });
      }
      return list;
    },

    async saveCredential({ providerId, authCookie, workspaceId }): Promise<void> {
      // Workspace 可留空：host 会取 Workspace 列表的第一个 `wrk_` 条目作为默认
      // （见 resolveWorkspaceId）。留空时按「自动」存空串。
      const trimmedWorkspaceId = workspaceId.trim();
      const normalizedWorkspaceId = trimmedWorkspaceId
        ? normalizeOpencodeWorkspaceId(trimmedWorkspaceId)
        : "";
      if (trimmedWorkspaceId && !normalizedWorkspaceId) {
        // 填了内容但提取不出 `wrk_…`：是用户抄错了，明确报错而不是悄悄当成自动。
        throw new Error("opencode_usage_workspace_id_invalid");
      }
      // Cookie 留空 = 保留已保存的凭据：用户改 Workspace 或只是想重新保存时
      // 不必再重贴整段 Cookie（凭据原文不回流 renderer，无法预填输入框）。
      const trimmedCookie = authCookie.trim();
      let cookieToStore: string;
      if (!trimmedCookie) {
        const existing = await loadCredential(providerId);
        if (!existing) {
          throw new Error("opencode_usage_cookie_required");
        }
        cookieToStore = existing.authCookie;
      } else {
        cookieToStore = normalizeOpencodeCookieHeader(trimmedCookie);
        if (!cookieToStore) {
          throw new Error("opencode_usage_cookie_required");
        }
      }
      const record: OpenCodeUsageCredentialRecord = {
        authCookie: cookieToStore,
        workspaceId: normalizedWorkspaceId,
        savedAt: now(),
      };
      await credentialService.save(credentialKey(providerId), JSON.stringify(record));
      // 换凭据后旧快照（含 last-good 展示值）与「该凭据读不了用量」的标记整体作废。
      forget(providerId);
      logger.info(undefined, "用量凭据已保存", {
        providerId,
        workspaceId: normalizedWorkspaceId || "(auto)",
        // 留空保存会沿用旧 Cookie（凭据原文不回流 renderer，无法预填），
        // cookieReplaced=false 时说明这次只改了 Workspace。
        cookieReplaced: Boolean(trimmedCookie),
      });
    },

    async clearCredential({ providerId }): Promise<void> {
      await credentialService.delete(credentialKey(providerId));
      forget(providerId);
    },

    async getCredentialHint({ providerId }): Promise<OpenCodeUsageCredentialHint | null> {
      const credential = await loadCredential(providerId);
      if (!credential) return null;
      // 只回显整个 Cookie 头的尾 4 位，避免 renderer 侧拿到原文。
      return {
        cookieTail: credential.authCookie.slice(-4),
        // 空串 = 保存时留给了自动定位（hint 契约里 workspaceId 恒为字符串）。
        workspaceId: credential.workspaceId,
      };
    },
  };
}
