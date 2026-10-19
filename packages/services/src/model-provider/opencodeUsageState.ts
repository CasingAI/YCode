import type { OpenCodeUsageSnapshot, OpenCodeZenBalanceSnapshot } from "@zcode/shared";

// ============================================================
// OpenCode 用量服务的缓存态（opencodeUsageService 的状态下沉）
// ============================================================
// 缓存容器与纯状态 helper 独立于服务编排，避免 Go/Zen 的快照与 last-good 状态
// 分散在服务逻辑之外；旧 Cookie/Workspace 缓存已随认证迁移删除。

export const CREDENTIAL_KEY_PREFIX = "opencode-usage:";
export const SNAPSHOT_TTL_MS = 60_000;

export interface SnapshotCacheEntry {
  snapshot: OpenCodeUsageSnapshot;
  fetchedAt: number;
  /**
   * 是否带可展示的窗口值。错误快照也会带上一次成功的窗口（见 lastGood），
   * 这种条目同样可以让 UI 立即出数，只是同时提示错误。
   */
  hasValues: boolean;
}

export interface ZenSnapshotCacheEntry {
  snapshot: OpenCodeZenBalanceSnapshot;
  fetchedAt: number;
  hasValues: boolean;
}

/** 工厂内全部可变状态的唯一容器：读写只经本模块 helper，不在外层散落。 */
export interface OpenCodeUsageCaches {
  snapshotCache: Map<string, SnapshotCacheEntry>;
  lastGood: Map<string, OpenCodeUsageSnapshot>;
  zenSnapshotCache: Map<string, ZenSnapshotCacheEntry>;
  zenLastGood: Map<string, OpenCodeZenBalanceSnapshot>;
}

export function createOpenCodeUsageCaches(): OpenCodeUsageCaches {
  return {
    snapshotCache: new Map(),
    lastGood: new Map(),
    zenSnapshotCache: new Map(),
    zenLastGood: new Map(),
  };
}

export function credentialKey(providerId: string): string {
  return `${CREDENTIAL_KEY_PREFIX}${providerId}`;
}

export function emptySnapshot(providerId: string, now: number): OpenCodeUsageSnapshot {
  return {
    providerId,
    fetchedAt: now,
    windows: [],
    error: null,
    errorMessage: null,
  };
}

export function cacheSnapshot(
  caches: OpenCodeUsageCaches,
  providerId: string,
  snapshot: OpenCodeUsageSnapshot,
  fetchedAt: number,
): void {
  caches.snapshotCache.set(providerId, {
    snapshot,
    fetchedAt,
    hasValues: snapshot.windows.length > 0,
  });
}

/** 失败快照补上最近一次成功窗口：错误提示与旧值并存，UI 不会退回空白。 */
export function attachLastGood(
  caches: OpenCodeUsageCaches,
  providerId: string,
  snapshot: OpenCodeUsageSnapshot,
): OpenCodeUsageSnapshot {
  if (snapshot.error === null) return snapshot;
  const good = caches.lastGood.get(providerId);
  if (!good) return snapshot;
  return { ...snapshot, windows: good.windows, fetchedAt: good.fetchedAt };
}

export function cacheZenSnapshot(
  caches: OpenCodeUsageCaches,
  providerId: string,
  snapshot: OpenCodeZenBalanceSnapshot,
  fetchedAt: number,
): void {
  caches.zenSnapshotCache.set(providerId, {
    snapshot,
    fetchedAt,
    hasValues: snapshot.balances.length > 0,
  });
}

/** 失败快照补上最近一次成功余额：错误提示与旧值并存，UI 不会退回空白。 */
export function attachZenLastGood(
  caches: OpenCodeUsageCaches,
  providerId: string,
  snapshot: OpenCodeZenBalanceSnapshot,
): OpenCodeZenBalanceSnapshot {
  if (snapshot.error === null) return snapshot;
  const good = caches.zenLastGood.get(providerId);
  if (!good) return snapshot;
  return { ...snapshot, balances: good.balances, fetchedAt: good.fetchedAt };
}
