import type { OpenCodeUsageSnapshot, OpenCodeZenBalanceSnapshot } from "@zcode/shared";

// ============================================================
// OpenCode 用量服务的缓存态（opencodeUsageService 的状态下沉）
// ============================================================
// 原因：opencodeUsageService.ts 基线超行（545 行，上限 400），缓存容器与
// 纯状态 helper 全是无副作用的 followers（见下注释），抽到独立模块后主文件
// 只保留服务编排（工厂 + 公开方法）。行为零改动。

export const CREDENTIAL_KEY_PREFIX = "opencode-usage:";
export const SNAPSHOT_TTL_MS = 60_000;

export interface OpenCodeUsageCredentialRecord {
  /** Zen Console 用户粘贴并归一化后的 Cookie 请求头（原样透传）。 */
  authCookie: string;
  workspaceId: string;
  savedAt: number;
}

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
  /**
   * Zen Console Cookie 已失效（401）的凭据标记（savedAt）；Go API Key 不使用此缓存。
   */
  staleCredential: Map<string, number>;
  /** 自动定位的默认 Workspace id（savedAt 变化即失效）。 */
  workspaceIdCache: Map<string, { savedAt: number; workspaceId: string }>;
}

export function createOpenCodeUsageCaches(): OpenCodeUsageCaches {
  return {
    snapshotCache: new Map(),
    lastGood: new Map(),
    zenSnapshotCache: new Map(),
    zenLastGood: new Map(),
    staleCredential: new Map(),
    workspaceIdCache: new Map(),
  };
}

export function credentialKey(providerId: string): string {
  return `${CREDENTIAL_KEY_PREFIX}${providerId}`;
}

export function emptySnapshot(providerId: string, now: number): OpenCodeUsageSnapshot {
  return {
    providerId,
    workspaceId: null,
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

export function forget(caches: OpenCodeUsageCaches, providerId: string): void {
  caches.snapshotCache.delete(providerId);
  caches.lastGood.delete(providerId);
  caches.zenSnapshotCache.delete(providerId);
  caches.zenLastGood.delete(providerId);
  caches.staleCredential.delete(providerId);
  caches.workspaceIdCache.delete(providerId);
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
