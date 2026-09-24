import type {
  OpenCodeUsageCredentialHint,
  OpenCodeUsageErrorKind,
  OpenCodeUsageSnapshot,
} from "@zcode/shared";

export interface OpenCodeUsageProjection {
  lastGood: OpenCodeUsageSnapshot | null;
  error: OpenCodeUsageErrorKind | null;
  hint: OpenCodeUsageCredentialHint | null;
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
  hint: OpenCodeUsageCredentialHint | null;
}): OpenCodeUsageProjection | null {
  const { previous, snapshot, hint } = params;
  if (snapshot.error === "not-configured") return null;

  return {
    // host 的错误快照可能已附上同 provider 的 last-good；没有窗口时才回退到 renderer 旧值。
    lastGood: snapshot.windows.length > 0 ? snapshot : (previous?.lastGood ?? null),
    error: snapshot.error,
    hint,
  };
}
