import type { MiniMaxQuotaErrorKind, MiniMaxQuotaSnapshot } from "@zcode/shared";

export interface MiniMaxQuotaProjection {
  lastGood: MiniMaxQuotaSnapshot | null;
  error: MiniMaxQuotaErrorKind | null;
}

interface MiniMaxQuotaProjectionStore {
  entries: Map<string, MiniMaxQuotaProjection>;
  generations: Map<string, number>;
}

/**
 * 按 Service 实例与 providerId 隔离的 renderer 展示投影：让详情子树因供应商选择重挂载时，
 * 该 provider 上次的额度在首帧直接可见（不等一次网络往返）。
 * 可丢弃、不是持久化或第二份业务事实；命中后仍会向 host 校验新鲜度。
 */
const projectionCache = new WeakMap<object, MiniMaxQuotaProjectionStore>();

function getStore(service: object): MiniMaxQuotaProjectionStore {
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

export function readMiniMaxQuotaProjection(
  service: object,
  providerId: string,
): MiniMaxQuotaProjection | null {
  return getStore(service).entries.get(providerId) ?? null;
}

export function beginMiniMaxQuotaProjectionRequest(service: object, providerId: string): number {
  const store = getStore(service);
  const generation = (store.generations.get(providerId) ?? 0) + 1;
  store.generations.set(providerId, generation);
  return generation;
}

export function isCurrentMiniMaxQuotaProjectionRequest(
  service: object,
  providerId: string,
  generation: number,
): boolean {
  return getStore(service).generations.get(providerId) === generation;
}

export function commitMiniMaxQuotaProjection(params: {
  service: object;
  providerId: string;
  generation: number;
  projection: MiniMaxQuotaProjection;
}): boolean {
  const { service, providerId, generation, projection } = params;
  const store = getStore(service);
  if (store.generations.get(providerId) !== generation) return false;
  store.entries.set(providerId, projection);
  return true;
}

export function clearMiniMaxQuotaProjection(service: object, providerId: string): number {
  const store = getStore(service);
  const generation = (store.generations.get(providerId) ?? 0) + 1;
  store.generations.set(providerId, generation);
  store.entries.delete(providerId);
  return generation;
}

/**
 * 快照 → 投影：只有成功快照更新窗口值；失败保留上一笔展示值。
 * `not-configured`（provider 已被清掉订阅 Key）不再可信，清除该 provider 的投影。
 */
export function projectMiniMaxQuotaResponse(params: {
  previous: MiniMaxQuotaProjection | null;
  snapshot: MiniMaxQuotaSnapshot;
}): MiniMaxQuotaProjection | null {
  const { previous, snapshot } = params;
  if (snapshot.error === "not-configured") return null;
  return {
    // host 的错误快照可能已附上同 provider 的 last-good；没有窗口时才回退到 renderer 旧值。
    lastGood: snapshot.windows.length > 0 ? snapshot : (previous?.lastGood ?? null),
    error: snapshot.error,
  };
}
