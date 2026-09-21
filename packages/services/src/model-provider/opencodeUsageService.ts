import { ServiceChannels } from "@zcode/shared";
import type {
  OpenCodeUsageCredentialHint,
  OpenCodeUsageCredentialInput,
  OpenCodeUsageErrorKind,
  OpenCodeUsageSnapshot,
  OpenCodeUsageWindow,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  buildOpencodeAuthCookieHeader,
  normalizeOpencodeWorkspaceId,
  parseOpencodeUsageText,
} from "./opencodeUsageParse.js";

/**
 * OpenCode 套餐用量查询服务。
 *
 * 凭据（auth Cookie + Workspace ID）唯一持久化在 ICredentialService（host 进程），
 * key 为 `opencode-usage:<providerId>`；快照只是 60s TTL 的内存派生缓存。
 * 请求只在 host 进程发出，renderer 经 RPC 代理调用，不直连 opencode.ai。
 */
export interface IOpenCodeUsageService {
  getSnapshot(input: { providerId: string; refresh?: boolean }): Promise<OpenCodeUsageSnapshot>;
  saveCredential(input: OpenCodeUsageCredentialInput): Promise<void>;
  clearCredential(input: { providerId: string }): Promise<void>;
  getCredentialHint(input: { providerId: string }): Promise<OpenCodeUsageCredentialHint | null>;
}

export const IOpenCodeUsageService = createServiceDescriptor<IOpenCodeUsageService>(
  ServiceChannels.OpenCodeUsage,
);

const CREDENTIAL_KEY_PREFIX = "opencode-usage:";
const SNAPSHOT_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const USAGE_PAGE_BASE_URL = "https://opencode.ai/workspace";
const SERVER_FN_BASE_URL = "https://opencode.ai/_server";
// Go 页面用量查询的 server function id（2026-09-21 从页面 network 实测取样）。
// 这是 opencode.ai 前端产物哈希，前端发版可能漂移：届时主路线失败，自动回退 HTML 路线。
const SERVER_FN_ID = "c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd";
// 用量页面按浏览器渲染，非浏览器 UA 会被 Cloudflare 拦截。
const REQUEST_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

/**
 * 构造 `_server` 端点的 args 参数（2026-09-21 实测样本，`a[0].s` 为 workspace id）。
 * 端点返回纯 JS（`;0x...;` 头 + `$R[n] = { ...Usage... }`），三窗口齐整且形态稳定。
 */
function buildServerFnArgs(workspaceId: string): string {
  return encodeURIComponent(
    JSON.stringify({
      t: { t: 9, i: 0, l: 1, a: [{ t: 1, s: workspaceId }], o: 0 },
      f: 31,
      m: [],
    }),
  );
}

interface OpenCodeUsageCredentialRecord {
  /** 归一化后的 `auth=<value>`，仅存于凭据存储，不落日志。 */
  authCookie: string;
  workspaceId: string;
  savedAt: number;
}

interface SnapshotCacheEntry {
  snapshot: OpenCodeUsageSnapshot;
  fetchedAt: number;
  /** 仅成功解析（error==null）的快照才可作 last-good 展示值。 */
  good: boolean;
}

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
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? Date.now;
  const { credentialService } = dependencies;
  /**
   * 最近一次结果（成功或失败），用于 60s 请求节流；失败结果 TTL 过期后重试。
   * lastGood 单独存最近一次成功快照：getSnapshot(refresh=false) 在缓存过期时
   * 立即返回它（stale-while-revalidate）并后台刷新，UI 不再退回「未加载」形态。
   */
  const snapshotCache = new Map<string, SnapshotCacheEntry>();
  const inflightRefresh = new Map<string, Promise<void>>();

  function cacheSnapshot(providerId: string, snapshot: OpenCodeUsageSnapshot): void {
    snapshotCache.set(providerId, {
      snapshot,
      fetchedAt: now(),
      good: snapshot.error === null && snapshot.windows.length > 0,
    });
  }

  async function loadCredential(providerId: string): Promise<OpenCodeUsageCredentialRecord | null> {
    const raw = await credentialService.load(credentialKey(providerId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as OpenCodeUsageCredentialRecord;
      if (!parsed?.authCookie || !parsed?.workspaceId) return null;
      return parsed;
    } catch {
      logger.warn(undefined, "凭据记录损坏，按未配置处理", { providerId });
      return null;
    }
  }

  /**
   * server-fn 主路线：`_server` 端点返回纯 JS、三窗口齐整且形态稳定。
   * 任何失败（非 2xx、网络异常、解析零窗口）都返回 null，由调用方回退 HTML 路线。
   */
  async function fetchFromServerFn(
    credential: OpenCodeUsageCredentialRecord,
  ): Promise<OpenCodeUsageWindow[] | null> {
    try {
      const url = `${SERVER_FN_BASE_URL}?id=${SERVER_FN_ID}&args=${buildServerFnArgs(
        credential.workspaceId,
      )}`;
      const { status, body } = await fetchUsagePage(url, credential.authCookie);
      if (status < 200 || status >= 300) return null;
      return parseOpencodeUsageText(body, now());
    } catch {
      return null;
    }
  }

  /** HTML 回退路线：从 Go 页面内嵌 store state 解析；401/403/404 等错误语义在此判定。 */
  async function fetchFromUsagePage(
    providerId: string,
    credential: OpenCodeUsageCredentialRecord,
  ): Promise<OpenCodeUsageSnapshot> {
    const url = `${USAGE_PAGE_BASE_URL}/${encodeURIComponent(credential.workspaceId)}/go`;
    try {
      const { status, body } = await fetchUsagePage(url, credential.authCookie);
      if (status === 401 || status === 403) {
        return {
          ...emptySnapshot(providerId, now()),
          workspaceId: credential.workspaceId,
          error: "credential-stale",
          errorMessage: `opencode.ai returned HTTP ${status}`,
        };
      }
      if (status === 404) {
        return {
          ...emptySnapshot(providerId, now()),
          workspaceId: credential.workspaceId,
          error: "workspace-not-found",
          errorMessage: `opencode.ai returned HTTP 404 for ${credential.workspaceId}`,
        };
      }
      if (status < 200 || status >= 300) {
        return {
          ...emptySnapshot(providerId, now()),
          workspaceId: credential.workspaceId,
          error: "unavailable",
          errorMessage: `opencode.ai returned HTTP ${status}`,
        };
      }
      const windows: OpenCodeUsageWindow[] | null = parseOpencodeUsageText(body, now());
      return windows
        ? {
            providerId,
            workspaceId: credential.workspaceId,
            fetchedAt: now(),
            windows,
            error: null,
            errorMessage: null,
          }
        : {
            ...emptySnapshot(providerId, now()),
            workspaceId: credential.workspaceId,
            error: "unavailable",
            errorMessage: "usage page structure changed: no window parsed",
          };
    } catch (error) {
      return {
        ...emptySnapshot(providerId, now()),
        workspaceId: credential.workspaceId,
        error: "unavailable",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 拉取并解析用量，写入节流缓存；失败不覆盖 last-good，错误由返回值承载。 */
  async function fetchSnapshot(providerId: string): Promise<OpenCodeUsageSnapshot> {
    const credential = await loadCredential(providerId);
    if (!credential) {
      const snapshot: OpenCodeUsageSnapshot = {
        ...emptySnapshot(providerId, now()),
        error: "not-configured",
      };
      cacheSnapshot(providerId, snapshot);
      return snapshot;
    }

    const serverFnWindows = await fetchFromServerFn(credential);
    if (serverFnWindows && serverFnWindows.length > 0) {
      const snapshot: OpenCodeUsageSnapshot = {
        providerId,
        workspaceId: credential.workspaceId,
        fetchedAt: now(),
        windows: serverFnWindows,
        error: null,
        errorMessage: null,
      };
      cacheSnapshot(providerId, snapshot);
      return snapshot;
    }

    // 主路线失败常见于 opencode.ai 前端发版导致 server function id 漂移；
    // 回退 HTML 路线兜底，同时留 info 便于发现漂移。
    logger.info(undefined, "server-fn 主路线未取到用量，回退 Go 页面 HTML", { providerId });
    const snapshot = await fetchFromUsagePage(providerId, credential);
    cacheSnapshot(providerId, snapshot);
    if (snapshot.error) {
      // warn 级别：用量查询失败不影响会话，可恢复；消息不含凭据。
      logger.warn(undefined, "用量查询失败", {
        providerId,
        errorKind: snapshot.error satisfies OpenCodeUsageErrorKind,
        message: snapshot.errorMessage,
      });
    }
    return snapshot;
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

  async function fetchUsagePage(
    url: string,
    authCookie: string,
  ): Promise<{
    status: number;
    body: string;
  }> {
    const response = await fetchImpl(url, {
      headers: {
        Cookie: authCookie,
        "User-Agent": REQUEST_USER_AGENT,
        // 同一请求函数服务 Go 页面（HTML）与 _server 端点（JS），Accept 放宽。
        Accept: "*/*",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 只取前 4 MiB：store state 内嵌在文档头部，足够解析且防异常大响应。
    const body = (await response.text()).slice(0, 4 << 20);
    return { status: response.status, body };
  }

  return {
    async getSnapshot({ providerId, refresh }): Promise<OpenCodeUsageSnapshot> {
      const cached = snapshotCache.get(providerId);
      if (!refresh && cached) {
        if (now() - cached.fetchedAt < SNAPSHOT_TTL_MS) {
          return cached.snapshot;
        }
        if (cached.good) {
          // 过期的成功快照立即返回（保持「始终显示上一次的值」），刷新转后台。
          triggerBackgroundRefresh(providerId);
          return cached.snapshot;
        }
      }

      const snapshot = await fetchSnapshot(providerId);
      return snapshot;
    },

    async saveCredential({ providerId, authCookie, workspaceId }): Promise<void> {
      const normalizedCookie = buildOpencodeAuthCookieHeader(authCookie);
      const normalizedWorkspaceId = normalizeOpencodeWorkspaceId(workspaceId);
      if (!normalizedCookie) {
        throw new Error("opencode_usage_cookie_required");
      }
      if (!normalizedWorkspaceId) {
        throw new Error("opencode_usage_workspace_id_invalid");
      }
      const record: OpenCodeUsageCredentialRecord = {
        authCookie: normalizedCookie,
        workspaceId: normalizedWorkspaceId,
        savedAt: now(),
      };
      await credentialService.save(credentialKey(providerId), JSON.stringify(record));
      // 换凭据后旧快照（含 last-good 展示值）整体作废，下一次 getSnapshot 强制重取。
      snapshotCache.delete(providerId);
      logger.info(undefined, "用量凭据已保存", {
        providerId,
        workspaceId: normalizedWorkspaceId,
      });
    },

    async clearCredential({ providerId }): Promise<void> {
      await credentialService.delete(credentialKey(providerId));
      snapshotCache.delete(providerId);
    },

    async getCredentialHint({ providerId }): Promise<OpenCodeUsageCredentialHint | null> {
      const credential = await loadCredential(providerId);
      if (!credential) return null;
      const value = credential.authCookie.startsWith("auth=")
        ? credential.authCookie.slice(5)
        : credential.authCookie;
      return {
        // 只回显尾 4 位，避免 renderer 侧拿到原文。
        cookieTail: value.slice(-4),
        workspaceId: credential.workspaceId,
      };
    },
  };
}
