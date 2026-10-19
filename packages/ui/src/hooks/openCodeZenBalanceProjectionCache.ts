import type { OpenCodeUsageErrorKind, OpenCodeZenBalanceSnapshot } from "@zcode/shared";

export interface OpenCodeZenBalanceProjection {
  lastGood: OpenCodeZenBalanceSnapshot | null;
  error: OpenCodeUsageErrorKind | null;
}

interface OpenCodeZenBalanceProjectionStore {
  entries: Map<string, OpenCodeZenBalanceProjection>;
  generations: Map<string, number>;
}

/**
 * 按 Service 实例与 providerId 隔离的 renderer 展示投影：让详情子树因供应商选择重挂载时，
 * 该 provider 上次的 Zen 余额在首帧直接可见（不等一次网络往返）。
 * 可丢弃、不是持久化或第二份业务事实；命中后仍会向 host 校验新鲜度。
 * 与 Go 套餐窗口投影相互独立（同一 provider 不会同时是 Go 与 Zen）。
 */
const projectionCache = new WeakMap<object, OpenCodeZenBalanceProjectionStore>();

function getStore(service: object): OpenCodeZenBalanceProjectionStore {
  let store = projectionCache.get(service);
  if (!store) {
    store = {
      entries: new Map(),
      generations: new Map(),
    };
    projectionCache.set(service, store);
  }
  return store;
}

export function readOpenCodeZenBalanceProjection(
  service: object,
  providerId: string,
): OpenCodeZenBalanceProjection | null {
  return getStore(service).entries.get(providerId) ?? null;
}

export function beginOpenCodeZenBalanceProjectionRequest(
  service: object,
  providerId: string,
): number {
  const store = getStore(service);
  const generation = (store.generations.get(providerId) ?? 0) + 1;
  store.generations.set(providerId, generation);
  return generation;
}

export function isCurrentOpenCodeZenBalanceProjectionRequest(
  service: object,
  providerId: string,
  generation: number,
): boolean {
  return getStore(service).generations.get(providerId) === generation;
}

export function commitOpenCodeZenBalanceProjection(params: {
  service: object;
  providerId: string;
  generation: number;
  projection: OpenCodeZenBalanceProjection;
}): boolean {
  const { service, providerId, generation, projection } = params;
  const store = getStore(service);
  if (store.generations.get(providerId) !== generation) return false;
  store.entries.set(providerId, projection);
  return true;
}

export function clearOpenCodeZenBalanceProjection(service: object, providerId: string): number {
  const store = getStore(service);
  const generation = (store.generations.get(providerId) ?? 0) + 1;
  store.generations.set(providerId, generation);
  store.entries.delete(providerId);
  return generation;
}

/**
 * 快照 → 投影：只有成功快照更新余额；失败保留上一笔展示值。
 * `not-configured`（凭据已不存在）不再可信，清除该 provider 的投影。
 */
export function projectOpenCodeZenBalanceResponse(params: {
  previous: OpenCodeZenBalanceProjection | null;
  snapshot: OpenCodeZenBalanceSnapshot;
}): OpenCodeZenBalanceProjection | null {
  const { previous, snapshot } = params;
  if (snapshot.error === "not-configured") return null;
  const previousSnapshot = previous?.lastGood;
  const sameCredential =
    previousSnapshot?.credentialRevision === undefined ||
    snapshot.credentialRevision === undefined ||
    previousSnapshot.credentialRevision === snapshot.credentialRevision;
  return {
    // API Key 变化后，失败结果不能回退到旧账号的余额。
    lastGood:
      snapshot.balances.length > 0 ? snapshot : sameCredential ? (previousSnapshot ?? null) : null,
    error: snapshot.error,
  };
}
