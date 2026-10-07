import type { OpenRouterBalanceErrorKind, OpenRouterBalanceSnapshot } from "@zcode/shared";

export interface OpenRouterBalanceProjection {
  lastGood: OpenRouterBalanceSnapshot | null;
  error: OpenRouterBalanceErrorKind | null;
}

interface OpenRouterBalanceProjectionStore {
  entries: Map<string, OpenRouterBalanceProjection>;
  generations: Map<string, number>;
}

/**
 * 按 Service 实例与 providerId 隔离的 renderer 展示投影：让详情子树因供应商选择重挂载时，
 * 该 provider 上次的余额在首帧直接可见（不等一次网络往返）。
 * 可丢弃、不是持久化或第二份业务事实；命中后仍会向 host 校验新鲜度。
 */
const projectionCache = new WeakMap<object, OpenRouterBalanceProjectionStore>();

function getStore(service: object): OpenRouterBalanceProjectionStore {
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

export function readOpenRouterBalanceProjection(
  service: object,
  providerId: string,
): OpenRouterBalanceProjection | null {
  return getStore(service).entries.get(providerId) ?? null;
}

export function beginOpenRouterBalanceProjectionRequest(
  service: object,
  providerId: string,
): number {
  const store = getStore(service);
  const generation = (store.generations.get(providerId) ?? 0) + 1;
  store.generations.set(providerId, generation);
  return generation;
}

export function isCurrentOpenRouterBalanceProjectionRequest(
  service: object,
  providerId: string,
  generation: number,
): boolean {
  return getStore(service).generations.get(providerId) === generation;
}

export function commitOpenRouterBalanceProjection(params: {
  service: object;
  providerId: string;
  generation: number;
  projection: OpenRouterBalanceProjection;
}): boolean {
  const { service, providerId, generation, projection } = params;
  const store = getStore(service);
  if (store.generations.get(providerId) !== generation) return false;
  store.entries.set(providerId, projection);
  return true;
}

export function clearOpenRouterBalanceProjection(service: object, providerId: string): number {
  const store = getStore(service);
  const generation = (store.generations.get(providerId) ?? 0) + 1;
  store.generations.set(providerId, generation);
  store.entries.delete(providerId);
  return generation;
}

/**
 * 快照 → 投影：只有成功快照更新金额；失败保留上一笔展示值。
 * `not-configured`（provider 已被清掉 API Key）不再可信，清除该 provider 的投影。
 */
export function projectOpenRouterBalanceResponse(params: {
  previous: OpenRouterBalanceProjection | null;
  snapshot: OpenRouterBalanceSnapshot;
}): OpenRouterBalanceProjection | null {
  const { previous, snapshot } = params;
  if (snapshot.error === "not-configured") return null;
  return {
    // host 的错误快照可能已附上同 provider 的 last-good；没有金额时才回退到 renderer 旧值。
    lastGood: snapshot.remaining !== null ? snapshot : (previous?.lastGood ?? null),
    error: snapshot.error,
  };
}
