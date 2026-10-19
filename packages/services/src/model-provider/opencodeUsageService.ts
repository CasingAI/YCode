import { ServiceChannels } from "@zcode/shared";
import type {
  OpenCodeUsageCredentialHint,
  OpenCodeUsageCredentialInput,
  OpenCodeUsageErrorKind,
  OpenCodeUsageSnapshot,
  OpenCodeWorkspaceList,
  OpenCodeZenBalanceSnapshot,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  createOpenCodeConsoleClient,
  normalizeOpencodeCookieHeader,
  normalizeOpencodeWorkspaceId,
} from "./opencodeConsoleApi.js";
import {
  SNAPSHOT_TTL_MS,
  attachLastGood,
  attachZenLastGood,
  cacheSnapshot,
  cacheZenSnapshot,
  createOpenCodeUsageCaches,
  credentialKey,
  emptySnapshot,
  forget,
} from "./opencodeUsageState.js";
import {
  fetchGoUsage,
  fetchZenFromConsole,
  loadCredential,
  resolveCookie,
  type UsageRouteDeps,
} from "./opencodeUsageRoutes.js";

// ============================================================
// OpenCode 套餐用量查询服务（编排层）
// ============================================================
// 缓存态下沉到 opencodeUsageState.ts，console 取数下沉到
// opencodeUsageRoutes.ts（与 background 拆分同形）；本文件只保留服务编排
// （工厂 + 公开方法 + 落地函数），根 lint 超行收口。行为零改动。
//
// Go 套餐用量复用 provider 配置中已有的 API Key，不复制、不落盘密钥；Zen 余额仍需
// Console Cookie + Workspace，只有 Zen 的凭据保存在 ICredentialService。所有网络请求
// 都在 host 进程发出，renderer 经 RPC 代理调用，不直连 opencode.ai。
export interface IOpenCodeUsageService {
  getSnapshot(input: { providerId: string; refresh?: boolean }): Promise<OpenCodeUsageSnapshot>;
  /**
   * Zen 余额走 Console `billing/status`，仍使用单独的 Cookie + Workspace 配置。
   * 余额无窗口/重置时间，失败语义与 getSnapshot 一致（last-good 保留旧金额，
   * 仅 not-configured 清展示值）。
   */
  getZenBalance(input: {
    providerId: string;
    refresh?: boolean;
  }): Promise<OpenCodeZenBalanceSnapshot>;
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

export interface OpenCodeUsageServiceDependencies {
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  /** 只读复用 provider 配置中已有的 API Key；不把密钥写入本服务的凭据存储。 */
  resolveApiKey: (providerId: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
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
  const caches = createOpenCodeUsageCaches();
  const routes: UsageRouteDeps = { credentialService, consoleClient, logger, now, caches };
  const inflightRefresh = new Map<string, Promise<void>>();
  const inflightZenRefresh = new Map<string, Promise<void>>();
  // Go 额度的身份来自 provider API Key，而非 providerId 本身。仅保留摘要与递增代数，
  // 不缓存 Key 原文；密钥替换或删除后不能继续展示另一个账号的 last-good。
  const goKeyDigests = new Map<string, string>();
  const goKeyRevisions = new Map<string, number>();
  const goKeyReads = new Map<string, number>();

  async function resolveGoKey(providerId: string) {
    const read = (goKeyReads.get(providerId) ?? 0) + 1;
    goKeyReads.set(providerId, read);
    const apiKey = (await dependencies.resolveApiKey(providerId))?.trim() ?? "";
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
    const digest = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    // 同一个 Key 的并发读取可以共享已确认身份；只有读到更旧的不同 Key 才丢弃。
    if (
      goKeyReads.get(providerId) !== read &&
      goKeyDigests.has(providerId) &&
      goKeyDigests.get(providerId) !== digest
    )
      return null;
    if (goKeyDigests.get(providerId) !== digest) {
      goKeyDigests.set(providerId, digest);
      goKeyRevisions.set(providerId, (goKeyRevisions.get(providerId) ?? 0) + 1);
      caches.snapshotCache.delete(providerId);
      caches.lastGood.delete(providerId);
    }
    return { apiKey, revision: goKeyRevisions.get(providerId) ?? 0 };
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
      const result = attachLastGood(caches, providerId, snapshot);
      cacheSnapshot(caches, providerId, result, now());
      warnSnapshotError(providerId, result);
      return result;
    }
    if (snapshot.windows.length > 0) {
      caches.lastGood.set(providerId, snapshot);
      // 只记窗口 key 与已用百分比（非凭据信息）：窗口缺失时可据此区分是远端只回了
      // 部分窗口，还是展示端的问题。
      logger.info(undefined, "用量已更新", {
        providerId,
        windows: snapshot.windows.map((window) => window.key),
        usagePercent: snapshot.windows.map((window) => Math.round(window.usagePercent)),
      });
    }
    cacheSnapshot(caches, providerId, snapshot, now());
    return snapshot;
  }

  function finishWithZenSnapshot(
    providerId: string,
    snapshot: OpenCodeZenBalanceSnapshot,
  ): OpenCodeZenBalanceSnapshot {
    if (snapshot.error !== null) {
      const result = attachZenLastGood(caches, providerId, snapshot);
      cacheZenSnapshot(caches, providerId, result, now());
      warnSnapshotError(providerId, {
        ...emptySnapshot(providerId, result.fetchedAt),
        workspaceId: result.workspaceId,
        error: result.error,
        errorMessage: result.errorMessage,
      });
      return result;
    }
    caches.zenLastGood.set(providerId, snapshot);
    logger.info(undefined, "Zen 余额已更新", {
      providerId,
      currencies: snapshot.balances.map((entry) => entry.currency),
    });
    cacheZenSnapshot(caches, providerId, snapshot, now());
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

  /** 拉取并解析用量，写入节流缓存；失败不覆盖 last-good，错误由返回值承载。 */
  async function fetchSnapshot(
    providerId: string,
    apiKey: string,
    revision: number,
  ): Promise<OpenCodeUsageSnapshot> {
    const finish = (snapshot: OpenCodeUsageSnapshot) => {
      // 新 Key 已被观察到时，旧 Key 的晚到结果一律不得回写缓存。
      if (goKeyRevisions.get(providerId) !== revision) {
        return {
          ...emptySnapshot(providerId, now()),
          error: "unavailable" as const,
          credentialRevision: revision,
        };
      }
      return finishWithSnapshot(providerId, { ...snapshot, credentialRevision: revision });
    };
    if (!apiKey) {
      // 无 Key 的缓存已在 resolveGoKey 中随身份变更被清空。
      const snapshot: OpenCodeUsageSnapshot = {
        ...emptySnapshot(providerId, now()),
        error: "not-configured",
      };
      return finish(snapshot);
    }
    const outcome = await fetchGoUsage(routes, providerId, apiKey);
    if (outcome.kind === "snapshot") return finish(outcome.snapshot);
    if (outcome.kind === "auth-rejected") {
      logger.warn(undefined, "OpenCode Go usage API 拒绝了 provider API Key", {
        providerId,
        status: outcome.status,
      });
      const snapshot: OpenCodeUsageSnapshot = {
        ...emptySnapshot(providerId, now()),
        error: "credential-stale",
        errorMessage: `OpenCode Go usage API rejected the provider API key (HTTP ${outcome.status})`,
      };
      return finish(snapshot);
    }
    if (outcome.kind === "subscription-required") {
      const snapshot: OpenCodeUsageSnapshot = {
        ...emptySnapshot(providerId, now()),
        error: "subscription-required",
        errorMessage:
          "The Go usage API could not find a usable subscription usage record for this API key",
      };
      return finish(snapshot);
    }
    logger.info(undefined, "OpenCode Go usage API 未返回可用额度", {
      providerId,
      status: outcome.status,
    });
    const snapshot: OpenCodeUsageSnapshot = {
      ...emptySnapshot(providerId, now()),
      error: "unavailable",
      errorMessage: "Go usage API returned no usable quota windows",
    };
    return finish(snapshot);
  }

  /** 拉取并解析 Zen 余额，写入节流缓存；失败不覆盖 last-good，错误由返回值承载。 */
  async function fetchZenSnapshot(providerId: string): Promise<OpenCodeZenBalanceSnapshot> {
    const credential = await loadCredential(routes, providerId);
    if (!credential) {
      forget(caches, providerId);
      const snapshot: OpenCodeZenBalanceSnapshot = {
        providerId,
        workspaceId: null,
        fetchedAt: now(),
        balances: [],
        error: "not-configured",
        errorMessage: null,
      };
      cacheZenSnapshot(caches, providerId, snapshot, now());
      return snapshot;
    }
    const knownRejected = caches.staleCredential.get(providerId) === credential.savedAt;
    let status: number | null = knownRejected ? 401 : null;
    if (!knownRejected) {
      const outcome = await fetchZenFromConsole(routes, providerId, credential);
      if (outcome.kind === "snapshot") {
        return finishWithZenSnapshot(providerId, outcome.snapshot);
      }
      status = outcome.status;
      if (outcome.kind === "auth-rejected" && outcome.status === 401) {
        caches.staleCredential.set(providerId, credential.savedAt);
      }
    }
    if (status !== null && (status === 401 || status === 403)) {
      logger.warn(undefined, "console 拒绝了该凭据", { providerId, status });
      return finishWithZenSnapshot(providerId, {
        providerId,
        workspaceId: credential.workspaceId || null,
        fetchedAt: now(),
        balances: [],
        error: "credential-stale",
        errorMessage: `opencode.ai did not authorise the request (HTTP ${status})`,
      });
    }
    logger.info(undefined, "Zen 余额未取到", { providerId, status });
    return finishWithZenSnapshot(providerId, {
      providerId,
      workspaceId: credential.workspaceId || null,
      fetchedAt: now(),
      balances: [],
      error: "unavailable",
      errorMessage: "billing/status returned no balance",
    });
  }

  /**
   * 后台刷新（stale-while-revalidate 的 refresh 半边）：去重防并发重复 GET，
   * 完成后更新节流缓存，下一次 getSnapshot 即可拿到新值。
   */
  function triggerBackgroundRefresh(providerId: string, apiKey: string, revision: number): void {
    if (inflightRefresh.has(providerId)) return;
    const task = (async () => {
      try {
        await fetchSnapshot(providerId, apiKey, revision);
      } catch {
        // 后台刷新失败静默：节流缓存保留 last-good，由下一次调用重试。
      } finally {
        inflightRefresh.delete(providerId);
      }
    })();
    inflightRefresh.set(providerId, task);
  }

  /** Zen 余额使用独立的 in-flight map，避免与 Go 套餐查询互相阻塞。 */
  function triggerZenBackgroundRefresh(providerId: string): void {
    if (inflightZenRefresh.has(providerId)) return;
    const task = (async () => {
      try {
        await fetchZenSnapshot(providerId);
      } catch {
        // 后台刷新失败静默：节流缓存保留 last-good，由下一次调用重试。
      } finally {
        inflightZenRefresh.delete(providerId);
      }
    })();
    inflightZenRefresh.set(providerId, task);
  }

  return {
    async getSnapshot({ providerId, refresh }): Promise<OpenCodeUsageSnapshot> {
      let key: Awaited<ReturnType<typeof resolveGoKey>>;
      try {
        key = await resolveGoKey(providerId);
      } catch {
        logger.warn(undefined, "读取 provider API Key 失败", { providerId });
        return finishWithSnapshot(providerId, {
          ...emptySnapshot(providerId, now()),
          error: "unavailable",
          errorMessage: "Unable to read the configured provider API key",
        });
      }
      if (!key) return { ...emptySnapshot(providerId, now()), error: "unavailable" };
      const cached = caches.snapshotCache.get(providerId);
      if (!refresh && cached) {
        if (now() - cached.fetchedAt < SNAPSHOT_TTL_MS) {
          return cached.snapshot;
        }
        if (cached.hasValues) {
          // 过期但有展示值（含「失败 + 旧值」形态）立即返回，刷新转后台：
          // 界面永远先出数字，不给用户看空白。
          triggerBackgroundRefresh(providerId, key.apiKey, key.revision);
          return cached.snapshot;
        }
      }
      return fetchSnapshot(providerId, key.apiKey, key.revision);
    },

    async getZenBalance({ providerId, refresh }): Promise<OpenCodeZenBalanceSnapshot> {
      const cached = caches.zenSnapshotCache.get(providerId);
      if (!refresh && cached) {
        if (now() - cached.fetchedAt < SNAPSHOT_TTL_MS) {
          return cached.snapshot;
        }
        if (cached.hasValues) {
          triggerZenBackgroundRefresh(providerId);
          return cached.snapshot;
        }
      }
      return fetchZenSnapshot(providerId);
    },

    async listWorkspaces({ providerId, authCookie }): Promise<OpenCodeWorkspaceList> {
      const resolved = await resolveCookie(routes, providerId, authCookie);
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
        const existing = await loadCredential(routes, providerId);
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
      await credentialService.save(
        credentialKey(providerId),
        JSON.stringify({
          authCookie: cookieToStore,
          workspaceId: normalizedWorkspaceId,
          savedAt: now(),
        }),
      );
      // 换凭据后旧快照（含 last-good 展示值）与「该凭据读不了用量」的标记整体作废。
      forget(caches, providerId);
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
      forget(caches, providerId);
    },

    async getCredentialHint({ providerId }): Promise<OpenCodeUsageCredentialHint | null> {
      const credential = await loadCredential(routes, providerId);
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
