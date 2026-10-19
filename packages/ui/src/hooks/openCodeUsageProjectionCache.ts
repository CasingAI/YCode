import type { OpenCodeUsageErrorKind, OpenCodeUsageSnapshot } from "@zcode/shared";

export interface OpenCodeUsageProjection {
  lastGood: OpenCodeUsageSnapshot | null;
  error: OpenCodeUsageErrorKind | null;
}

interface OpenCodeUsageProjectionStore {
  entries: Map<string, OpenCodeUsageProjection>;
  generations: Map<string, number>;
}

const projectionCache = new WeakMap<object, OpenCodeUsageProjectionStore>();

function getStore(service: object): OpenCodeUsageProjectionStore {
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

export function readOpenCodeUsageProjection(
  service: object,
  providerId: string,
): OpenCodeUsageProjection | null {
  return getStore(service).entries.get(providerId) ?? null;
}

export function beginOpenCodeUsageProjectionRequest(service: object, providerId: string): number {
  const store = getStore(service);
  const generation = (store.generations.get(providerId) ?? 0) + 1;
  store.generations.set(providerId, generation);
  return generation;
}

export function isCurrentOpenCodeUsageProjectionRequest(
  service: object,
  providerId: string,
  generation: number,
): boolean {
  return getStore(service).generations.get(providerId) === generation;
}

export function commitOpenCodeUsageProjection(params: {
  service: object;
  providerId: string;
  generation: number;
  projection: OpenCodeUsageProjection;
}): boolean {
  const { service, providerId, generation, projection } = params;
  const store = getStore(service);
  if (store.generations.get(providerId) !== generation) return false;
  store.entries.set(providerId, projection);
  return true;
}

export function invalidateOpenCodeUsageProjection(service: object, providerId: string): void {
  beginOpenCodeUsageProjectionRequest(service, providerId);
}

export function clearOpenCodeUsageProjection(service: object, providerId: string): number {
  const store = getStore(service);
  const generation = (store.generations.get(providerId) ?? 0) + 1;
  store.generations.set(providerId, generation);
  store.entries.delete(providerId);
  return generation;
}

export function projectOpenCodeUsageResponse(params: {
  previous: OpenCodeUsageProjection | null;
  snapshot: OpenCodeUsageSnapshot;
}): OpenCodeUsageProjection {
  const { previous, snapshot } = params;
  if (snapshot.error === "not-configured") {
    // 没有 API Key 时清掉旧额度，但仍保留错误状态，供不再带配置表单的 Go 卡片展示提示。
    return { lastGood: null, error: snapshot.error };
  }

  // 同一个 providerId 允许替换 API Key；新 Key 查询失败时不可回退到旧账号的剩余额度。
  const lastGood = previous?.lastGood;
  const sameCredential =
    lastGood?.credentialRevision === undefined ||
    snapshot.credentialRevision === undefined ||
    lastGood.credentialRevision === snapshot.credentialRevision;
  return {
    lastGood: snapshot.windows.length > 0 ? snapshot : sameCredential ? (lastGood ?? null) : null,
    error: snapshot.error,
  };
}
