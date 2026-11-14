import type { KeypressMetricSummary, ProbeCounters } from "./probes.js";

/**
 * 公开 API / 存储入口计数与键盘事件样本的运行时状态。
 *
 * 只在场景显式 beginMeasure / endMeasure 区间内累加；夹具自己的读取检查
 * （snapshot、monacoInfo、timeSnapshot 等）会临时挂起计数，避免把测试探针
 * 的读取算进「逐键路径」。补丁只包一层，不改变任何返回值和异常行为。
 */
const probeCounters: ProbeCounters = {
  getValue: 0,
  getValueLength: 0,
  getValueInRange: 0,
  getAlternativeVersionId: 0,
  localStorageWrites: 0,
  indexedDbPuts: 0,
};
let measureActive = false;
const patchedPrototypes = new WeakSet<object>();
let storageCountersInstalled = false;
let idbCountersInstalled = false;

export function resetProbeCounters(): void {
  probeCounters.getValue = 0;
  probeCounters.getValueLength = 0;
  probeCounters.getValueInRange = 0;
  probeCounters.getAlternativeVersionId = 0;
  probeCounters.localStorageWrites = 0;
  probeCounters.indexedDbPuts = 0;
}

export function snapshotProbeCounters(): ProbeCounters {
  return { ...probeCounters };
}

export function startMeasureCounters(): void {
  resetProbeCounters();
  measureActive = true;
}

export function stopMeasureCounters(): void {
  measureActive = false;
}

function patchMethod(
  target: object,
  name: string,
  select: (counters: ProbeCounters) => number,
): void {
  const record = target as Record<string, unknown>;
  const original = record[name];
  if (typeof original !== "function") return;
  record[name] = function patched(this: unknown, ...args: unknown[]) {
    if (measureActive) select(probeCounters);
    return (original as (...input: unknown[]) => unknown).apply(this, args);
  };
}

export function installPrototypeCounters(prototype: object): void {
  if (patchedPrototypes.has(prototype)) return;
  patchedPrototypes.add(prototype);
  patchMethod(prototype, "getValue", (counters) => (counters.getValue += 1));
  patchMethod(prototype, "getValueLength", (counters) => (counters.getValueLength += 1));
  patchMethod(prototype, "getValueInRange", (counters) => (counters.getValueInRange += 1));
  patchMethod(
    prototype,
    "getAlternativeVersionId",
    (counters) => (counters.getAlternativeVersionId += 1),
  );
}

export function installStorageCounters(): void {
  if (storageCountersInstalled) return;
  storageCountersInstalled = true;
  if (typeof Storage === "undefined") return;
  patchMethod(Storage.prototype, "setItem", (counters) => (counters.localStorageWrites += 1));
}

export function installIdbCounters(): void {
  if (idbCountersInstalled) return;
  idbCountersInstalled = true;
  if (typeof IDBObjectStore === "undefined") return;
  patchMethod(IDBObjectStore.prototype, "put", (counters) => (counters.indexedDbPuts += 1));
}

export function withCountersSuspended<T>(fn: () => T): T {
  const previous = measureActive;
  measureActive = false;
  try {
    return fn();
  } finally {
    measureActive = previous;
  }
}

export async function withCountersSuspendedAsync<T>(fn: () => Promise<T>): Promise<T> {
  const previous = measureActive;
  measureActive = false;
  try {
    return await fn();
  } finally {
    measureActive = previous;
  }
}

export function modelMatchesPath(
  model: { uri: { path: string } } | null | undefined,
  path: string | undefined,
): boolean {
  if (!model || !path) return false;
  const uriPath = model.uri.path;
  let decoded = uriPath;
  try {
    decoded = decodeURIComponent(uriPath);
  } catch {
    // 非法转义时保留原始路径字符串继续比较。
  }
  return decoded.endsWith(path) || uriPath.endsWith(path);
}

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return Math.round(sorted[index]! * 1000) / 1000;
}

export type KeypressRecord = { down: number; model?: number; store?: number };

export interface KeypressMetricsState {
  records: KeypressRecord[];
  onKeydown: () => void;
  modelSubscription: { dispose: () => void };
  storeUnsubscribe: () => void;
  modelChanges: number;
  storeChanges: number;
}

export function summarizeKeypressMetrics(metrics: KeypressMetricsState): KeypressMetricSummary {
  const modelDeltas: number[] = [];
  const storeDeltas: number[] = [];
  for (const record of metrics.records) {
    if (record.model !== undefined) modelDeltas.push(record.model - record.down);
    if (record.store !== undefined) storeDeltas.push(record.store - record.down);
  }
  const summary = (values: number[]) => ({
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length > 0 ? Math.round(Math.max(...values) * 1000) / 1000 : 0,
  });
  return {
    keydowns: metrics.records.length,
    modelChanges: metrics.modelChanges,
    storeChanges: metrics.storeChanges,
    paired: Math.max(modelDeltas.length, storeDeltas.length),
    modelMs: summary(modelDeltas),
    storeMs: summary(storeDeltas),
  };
}
