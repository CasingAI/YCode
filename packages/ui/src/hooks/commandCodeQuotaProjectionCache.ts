import type { CommandCodeQuotaErrorKind, CommandCodeQuotaSnapshot } from "@zcode/shared";

export interface CommandCodeQuotaProjection {
  lastGood: CommandCodeQuotaSnapshot | null;
  error: CommandCodeQuotaErrorKind | null;
}

interface CommandCodeQuotaProjectionStore {
  entries: Map<string, CommandCodeQuotaProjection>;
  generations: Map<string, number>;
}

/**
 * 按 Service 实例与 providerId 隔离的 renderer 展示投影：让详情子树因供应商选择重挂载时，
 * 该 provider 上次的额度在首帧直接可见（不等一次网络往返）。
 * 可丢弃、不是持久化或第二份业务事实；命中后仍会向 host 校验新鲜度。
 */
const projectionCache = new WeakMap<object, CommandCodeQuotaProjectionStore>();

function getStore(service: object): CommandCodeQuotaProjectionStore {
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

export function readCommandCodeQuotaProjection(
  service: object,
  providerId: string,
): CommandCodeQuotaProjection | null {
  return getStore(service).entries.get(providerId) ?? null;
}

export function beginCommandCodeQuotaProjectionRequest(
  service: object,
  providerId: string,
): number {
  const store = getStore(service);
  const generation = (store.generations.get(providerId) ?? 0) + 1;
  store.generations.set(providerId, generation);
  return generation;
}

export function isCurrentCommandCodeQuotaProjectionRequest(
  service: object,
  providerId: string,
  generation: number,
): boolean {
  return getStore(service).generations.get(providerId) === generation;
}

export function commitCommandCodeQuotaProjection(params: {
  service: object;
  providerId: string;
  generation: number;
  projection: CommandCodeQuotaProjection;
}): boolean {
  const { service, providerId, generation, projection } = params;
  const store = getStore(service);
  if (store.generations.get(providerId) !== generation) return false;
  store.entries.set(providerId, projection);
  return true;
}

/**
 * 快照 → 投影：只有成功快照更新窗口值；失败保留上一笔展示值。
 * `not-configured`（provider 已被清掉 API Key）不再可信：清除展示值，但**保留错误状态**，
 * 让卡片能显示「请先填写 API Key」的引导文案。返回 null 会把错误类别一起丢掉，
 * 卡片就只剩标题，变成没有解释的空白卡片。
 */
export function projectCommandCodeQuotaResponse(params: {
  previous: CommandCodeQuotaProjection | null;
  snapshot: CommandCodeQuotaSnapshot;
}): CommandCodeQuotaProjection {
  const { previous, snapshot } = params;
  if (snapshot.error === "not-configured") {
    return { lastGood: null, error: snapshot.error };
  }
  return {
    // host 的错误快照可能已附上同 provider 的 last-good；没有窗口时才回退到 renderer 旧值。
    lastGood: snapshot.windows.length > 0 ? snapshot : (previous?.lastGood ?? null),
    error: snapshot.error,
  };
}
