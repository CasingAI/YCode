import type {
  OpenCodeUsageErrorKind,
  OpenCodeUsageSnapshot,
  OpenCodeZenBalanceSnapshot,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import { ServiceChannels } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { createOpenCodeConsoleClient } from "./opencodeConsoleApi.js";
import {
  SNAPSHOT_TTL_MS,
  attachLastGood,
  attachZenLastGood,
  cacheSnapshot,
  cacheZenSnapshot,
  createOpenCodeUsageCaches,
  credentialKey,
  emptySnapshot,
} from "./opencodeUsageState.js";
import { fetchGoUsage, fetchZenFromConsole, type UsageRouteDeps } from "./opencodeUsageRoutes.js";

export interface IOpenCodeUsageService {
  getSnapshot(input: { providerId: string; refresh?: boolean }): Promise<OpenCodeUsageSnapshot>;
  getZenBalance(input: {
    providerId: string;
    refresh?: boolean;
  }): Promise<OpenCodeZenBalanceSnapshot>;
}

export const IOpenCodeUsageService = createServiceDescriptor<IOpenCodeUsageService>(
  ServiceChannels.OpenCodeUsage,
);

export interface OpenCodeUsageServiceDependencies {
  /** 仅用于删除旧版本保存的 Cookie 记录；新实现不再读取或保存这些凭据。 */
  legacyCredentialService?: Pick<ICredentialService, "delete">;
  /** 只读复用 Provider 配置中已有的 API Key；不复制、不持久化密钥。 */
  resolveApiKey: (providerId: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const LEGACY_OPENCODE_PROVIDER_IDS = [
  "opencode-go-chat",
  "opencode-go-responses",
  "opencode-zen-chat",
  "opencode-zen-responses",
];

function emptyZenSnapshot(providerId: string, now: number): OpenCodeZenBalanceSnapshot {
  return { providerId, fetchedAt: now, balances: [], error: null, errorMessage: null };
}

export function createOpenCodeUsageService(
  dependencies: OpenCodeUsageServiceDependencies,
): IOpenCodeUsageService {
  const logger = createServiceLogger("opencode-usage");
  const now = dependencies.now ?? Date.now;
  const consoleClient = createOpenCodeConsoleClient(dependencies);
  const caches = createOpenCodeUsageCaches();
  const routes: UsageRouteDeps = { consoleClient, logger, now };
  const inflightRefresh = new Map<string, Promise<void>>();
  const inflightZenRefresh = new Map<string, Promise<void>>();

  const goKeyDigests = new Map<string, string>();
  const goKeyRevisions = new Map<string, number>();
  const goKeyReads = new Map<string, number>();
  const zenKeyDigests = new Map<string, string>();
  const zenKeyRevisions = new Map<string, number>();
  const zenKeyReads = new Map<string, number>();

  // One-time cleanup for Cookie credentials written by older YCode versions.
  const legacyCredentialCleanup = new Set<string>();
  const legacyCredentialCleanupTasks = new Map<string, Promise<void>>();
  async function cleanupLegacyCredentials(providerId: string): Promise<void> {
    if (!dependencies.legacyCredentialService) return;
    const ids = new Set([...LEGACY_OPENCODE_PROVIDER_IDS, providerId]);
    await Promise.all(
      [...ids].map(async (id) => {
        if (legacyCredentialCleanup.has(id)) return;
        const existing = legacyCredentialCleanupTasks.get(id);
        if (existing) return existing;
        const task = (async () => {
          try {
            await dependencies.legacyCredentialService?.delete(credentialKey(id));
          } catch {
            // Legacy cleanup must not block quota queries. No credential values are logged.
            logger.info(undefined, "旧版 OpenCode 凭据清理失败", { providerId: id });
          } finally {
            legacyCredentialCleanup.add(id);
            legacyCredentialCleanupTasks.delete(id);
          }
        })();
        legacyCredentialCleanupTasks.set(id, task);
        return task;
      }),
    );
  }

  function clearGoCache(providerId: string): void {
    caches.snapshotCache.delete(providerId);
    caches.lastGood.delete(providerId);
  }

  function clearZenCache(providerId: string): void {
    caches.zenSnapshotCache.delete(providerId);
    caches.zenLastGood.delete(providerId);
  }

  async function resolveKeyIdentity(
    providerId: string,
    state: {
      digests: Map<string, string>;
      revisions: Map<string, number>;
      reads: Map<string, number>;
    },
    clearCache: (providerId: string) => void,
  ): Promise<{ apiKey: string; revision: number } | null> {
    const read = (state.reads.get(providerId) ?? 0) + 1;
    state.reads.set(providerId, read);
    const apiKey = (await dependencies.resolveApiKey(providerId))?.trim() ?? "";
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
    const digest = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (
      state.reads.get(providerId) !== read &&
      state.digests.has(providerId) &&
      state.digests.get(providerId) !== digest
    ) {
      return null;
    }
    if (state.digests.get(providerId) !== digest) {
      state.digests.set(providerId, digest);
      state.revisions.set(providerId, (state.revisions.get(providerId) ?? 0) + 1);
      clearCache(providerId);
    }
    return { apiKey, revision: state.revisions.get(providerId) ?? 0 };
  }

  function finishWithSnapshot(
    providerId: string,
    snapshot: OpenCodeUsageSnapshot,
  ): OpenCodeUsageSnapshot {
    if (snapshot.error !== null) {
      const result = attachLastGood(caches, providerId, snapshot);
      cacheSnapshot(caches, providerId, result, now());
      warnSnapshotError(providerId, result.error, result.errorMessage);
      return result;
    }
    if (snapshot.windows.length > 0) {
      caches.lastGood.set(providerId, snapshot);
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
    if (snapshot.error === "not-configured") {
      caches.zenLastGood.delete(providerId);
      cacheZenSnapshot(caches, providerId, snapshot, now());
      return snapshot;
    }
    if (snapshot.error !== null) {
      const result = attachZenLastGood(caches, providerId, snapshot);
      cacheZenSnapshot(caches, providerId, result, now());
      warnSnapshotError(providerId, result.error, result.errorMessage);
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

  function warnSnapshotError(
    providerId: string,
    error: OpenCodeUsageErrorKind | null,
    message: string | null,
  ): void {
    if (!error) return;
    logger.warn(undefined, "用量查询失败", { providerId, errorKind: error, message });
  }

  async function fetchSnapshot(
    providerId: string,
    apiKey: string,
    revision: number,
  ): Promise<OpenCodeUsageSnapshot> {
    const finish = (snapshot: OpenCodeUsageSnapshot) => {
      if (goKeyRevisions.get(providerId) !== revision) {
        return {
          ...emptySnapshot(providerId, now()),
          error: "unavailable" as const,
          credentialRevision: revision,
        };
      }
      return finishWithSnapshot(providerId, { ...snapshot, credentialRevision: revision });
    };
    if (!apiKey) return finish({ ...emptySnapshot(providerId, now()), error: "not-configured" });

    const outcome = await fetchGoUsage(routes, providerId, apiKey);
    if (outcome.kind === "snapshot") return finish(outcome.snapshot);
    if (outcome.kind === "auth-rejected") {
      const snapshot: OpenCodeUsageSnapshot = {
        ...emptySnapshot(providerId, now()),
        error: "credential-stale",
        errorMessage: `OpenCode Go usage API rejected the provider API key (HTTP ${outcome.status})`,
      };
      return finish(snapshot);
    }
    if (outcome.kind === "subscription-required") {
      return finish({
        ...emptySnapshot(providerId, now()),
        error: "subscription-required",
        errorMessage:
          "The Go usage API could not find a usable subscription usage record for this API key",
      });
    }
    logger.info(undefined, "OpenCode Go usage API 未返回可用额度", {
      providerId,
      status: outcome.status,
    });
    return finish({
      ...emptySnapshot(providerId, now()),
      error: "unavailable",
      errorMessage: "Go usage API returned no usable quota windows",
    });
  }

  async function fetchZenSnapshot(
    providerId: string,
    apiKey: string,
    revision: number,
  ): Promise<OpenCodeZenBalanceSnapshot> {
    const finish = (snapshot: OpenCodeZenBalanceSnapshot) => {
      if (zenKeyRevisions.get(providerId) !== revision) {
        return {
          ...emptyZenSnapshot(providerId, now()),
          error: "unavailable" as const,
          credentialRevision: revision,
        };
      }
      return finishWithZenSnapshot(providerId, { ...snapshot, credentialRevision: revision });
    };
    if (!apiKey) return finish({ ...emptyZenSnapshot(providerId, now()), error: "not-configured" });

    const outcome = await fetchZenFromConsole(routes, providerId, apiKey);
    if (outcome.kind === "snapshot") return finish(outcome.snapshot);
    if (outcome.kind === "auth-rejected") {
      logger.warn(undefined, "Console billing API 拒绝了 Provider API Key", {
        providerId,
        status: outcome.status,
      });
      return finish({
        ...emptyZenSnapshot(providerId, now()),
        error: "credential-stale",
        errorMessage: `OpenCode Console billing API rejected the provider API key (HTTP ${outcome.status})`,
      });
    }
    logger.info(undefined, "Zen 余额未取到", { providerId, status: outcome.status });
    return finish({
      ...emptyZenSnapshot(providerId, now()),
      error: "unavailable",
      errorMessage: "Console billing/status returned no usable balance",
    });
  }

  function triggerBackgroundRefresh(providerId: string, apiKey: string, revision: number): void {
    if (inflightRefresh.has(providerId)) return;
    const task = (async () => {
      try {
        await fetchSnapshot(providerId, apiKey, revision);
      } catch {
        // Background failure leaves last-good cached for the next request.
      } finally {
        inflightRefresh.delete(providerId);
      }
    })();
    inflightRefresh.set(providerId, task);
  }

  function triggerZenBackgroundRefresh(providerId: string, apiKey: string, revision: number): void {
    if (inflightZenRefresh.has(providerId)) return;
    const task = (async () => {
      try {
        await fetchZenSnapshot(providerId, apiKey, revision);
      } catch {
        // Background failure leaves last-good cached for the next request.
      } finally {
        inflightZenRefresh.delete(providerId);
      }
    })();
    inflightZenRefresh.set(providerId, task);
  }

  return {
    async getSnapshot({ providerId, refresh }): Promise<OpenCodeUsageSnapshot> {
      await cleanupLegacyCredentials(providerId);
      let key: Awaited<ReturnType<typeof resolveKeyIdentity>>;
      try {
        key = await resolveKeyIdentity(
          providerId,
          { digests: goKeyDigests, revisions: goKeyRevisions, reads: goKeyReads },
          clearGoCache,
        );
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
        if (now() - cached.fetchedAt < SNAPSHOT_TTL_MS) return cached.snapshot;
        if (cached.hasValues) {
          triggerBackgroundRefresh(providerId, key.apiKey, key.revision);
          return cached.snapshot;
        }
      }
      return fetchSnapshot(providerId, key.apiKey, key.revision);
    },

    async getZenBalance({ providerId, refresh }): Promise<OpenCodeZenBalanceSnapshot> {
      await cleanupLegacyCredentials(providerId);
      let key: Awaited<ReturnType<typeof resolveKeyIdentity>>;
      try {
        key = await resolveKeyIdentity(
          providerId,
          { digests: zenKeyDigests, revisions: zenKeyRevisions, reads: zenKeyReads },
          clearZenCache,
        );
      } catch {
        logger.warn(undefined, "读取 Zen Provider API Key 失败", { providerId });
        return finishWithZenSnapshot(providerId, {
          ...emptyZenSnapshot(providerId, now()),
          error: "unavailable",
          errorMessage: "Unable to read the configured provider API key",
        });
      }
      if (!key) return { ...emptyZenSnapshot(providerId, now()), error: "unavailable" };
      const cached = caches.zenSnapshotCache.get(providerId);
      if (!refresh && cached) {
        if (now() - cached.fetchedAt < SNAPSHOT_TTL_MS) return cached.snapshot;
        if (cached.hasValues) {
          triggerZenBackgroundRefresh(providerId, key.apiKey, key.revision);
          return cached.snapshot;
        }
      }
      return fetchZenSnapshot(providerId, key.apiKey, key.revision);
    },
  };
}
