/**
 * Renderer 性能诊断的纯聚合层：固定 stage、窗口累计器和摘要生成。
 *
 * 本文件不读取浏览器 API、不写日志、不持有定时器；runtime 层只通过这里累加数值，
 * 保证同一份计数口径可被单测直接验证，也避免把 wire/session 内容带进诊断。
 */
import {
  buildRendererPerformanceLoafMetrics,
  type RendererPerformanceLoafAccumulator,
  type RendererPerformanceLoafMetrics,
  type RendererPerformanceObserverMetrics,
} from "./rendererPerformanceDiagnosticsLoaf.js";
import { sanitizeRendererPerformanceNumber } from "./rendererPerformanceDiagnosticsNumbers.js";

export { sanitizeRendererPerformanceNumber } from "./rendererPerformanceDiagnosticsNumbers.js";
export type {
  RendererPerformanceLoafEntry,
  RendererPerformanceLoafMetrics,
  RendererPerformanceObserverMetrics,
} from "./rendererPerformanceDiagnosticsLoaf.js";

export type RendererPerformanceStage =
  | "conversation.frame"
  | "sessions-index.frame"
  | "sessions-index.items"
  | "conversation.share-units"
  | "conversation.turn-frame"
  | "react.session-pane";

export interface RendererPerformanceStageMetrics {
  count: number;
  durationMsSum: number;
  durationMsMax: number;
  /** 单次 duration >= slowThresholdMs 的次数。 */
  slowCount: number;
  /** 仅当至少一次调用提供合法 workUnits 时出现。 */
  workUnitsSum?: number;
  workUnitsMax?: number;
}

export interface RendererPerformanceRafMetrics {
  count: number;
  intervalMsSum: number;
  intervalMsMax: number;
  /** 帧间隔严格大于 50ms 的次数；固定异常阈值，不是刷新率预算或掉帧数。 */
  over50msCount: number;
}

export interface RendererPerformanceTimerMetrics {
  count: number;
  delayMsSum: number;
  delayMsMax: number;
}

export interface RendererPerformanceRuntimeMetrics {
  raf?: RendererPerformanceRafMetrics;
  timer?: RendererPerformanceTimerMetrics;
  longTask?: RendererPerformanceObserverMetrics;
  loaf?: RendererPerformanceLoafMetrics;
}

export interface RendererPerformanceCapabilities {
  performanceObserver: boolean;
  longTask: boolean;
  longAnimationFrame: boolean;
  requestAnimationFrame: boolean;
  reactProfiler: "dev-only" | "unavailable";
}

export interface RendererPerformanceObserved {
  rafSamples: number;
  timerSamples: number;
  longTaskEntries: number;
  loafEntries: number;
  reactProfilerCallbacks: number;
}

export interface RendererPerformanceSummaryV1 {
  version: 1;
  windowMs: number;
  stages: Partial<Record<RendererPerformanceStage, RendererPerformanceStageMetrics>>;
  runtime: RendererPerformanceRuntimeMetrics;
  capabilities: RendererPerformanceCapabilities;
  observed: RendererPerformanceObserved;
}

export interface RendererPerformanceStageAccumulator {
  count: number;
  durationMsSum: number;
  durationMsMax: number;
  slowCount: number;
  workUnitsSum?: number;
  workUnitsMax?: number;
}

interface NumberAggregate {
  count: number;
  sum: number;
  max: number;
}

interface ObserverAccumulator {
  count: number;
  duration?: NumberAggregate;
}

export interface RendererPerformanceWindowState {
  stages: Map<RendererPerformanceStage, RendererPerformanceStageAccumulator>;
  runtime: {
    raf?: RendererPerformanceRafMetrics;
    timer?: NumberAggregate;
    longTask?: ObserverAccumulator;
    loaf?: RendererPerformanceLoafAccumulator;
  };
  observed: RendererPerformanceObserved;
}

export const RENDERER_PERFORMANCE_WINDOW_MS = 10_000;
export const RENDERER_PERFORMANCE_SLOW_MS = 8;
export const RENDERER_PERFORMANCE_FRAME_ANOMALY_MS = 50;
export const RENDERER_PERFORMANCE_SAMPLE_TIMER_MS = 500;

const STAGE_NAMES: readonly RendererPerformanceStage[] = [
  "conversation.frame",
  "sessions-index.frame",
  "sessions-index.items",
  "conversation.share-units",
  "conversation.turn-frame",
  "react.session-pane",
];

const STAGE_SET = new Set<string>(STAGE_NAMES);

/** 只有这些 stage 的 workUnits 有意义；frame/profile stage 即使传入也必须忽略。 */
const STAGE_WORK_UNITS: ReadonlySet<RendererPerformanceStage> = new Set([
  "sessions-index.items",
  "conversation.share-units",
  "conversation.turn-frame",
]);

export function isRendererPerformanceStage(value: string): value is RendererPerformanceStage {
  return STAGE_SET.has(value);
}

/** 诊断数值只接受有限非负数；缺失、NaN、Infinity、负数一律视为无效。 */
export function createRendererPerformanceObserved(): RendererPerformanceObserved {
  return {
    rafSamples: 0,
    timerSamples: 0,
    longTaskEntries: 0,
    loafEntries: 0,
    reactProfilerCallbacks: 0,
  };
}

export function createRendererPerformanceWindowState(): RendererPerformanceWindowState {
  return {
    stages: new Map(),
    runtime: {},
    observed: createRendererPerformanceObserved(),
  };
}

export function resetRendererPerformanceWindowState(state: RendererPerformanceWindowState): void {
  state.stages.clear();
  state.runtime = {};
  state.observed = createRendererPerformanceObserved();
}

function addAggregate(aggregate: NumberAggregate | undefined, value: number): NumberAggregate {
  if (!aggregate) {
    return { count: 1, sum: value, max: value };
  }
  aggregate.count += 1;
  aggregate.sum += value;
  if (value > aggregate.max) {
    aggregate.max = value;
  }
  return aggregate;
}

export function recordRendererPerformanceStage(
  state: RendererPerformanceWindowState,
  stage: RendererPerformanceStage,
  durationMs: unknown,
  workUnits: unknown,
  slowThresholdMs: number,
): void {
  if (!isRendererPerformanceStage(stage)) {
    return;
  }
  const duration = sanitizeRendererPerformanceNumber(durationMs);
  if (duration === undefined) {
    return;
  }
  let accumulator = state.stages.get(stage);
  if (!accumulator) {
    accumulator = {
      count: 0,
      durationMsSum: 0,
      durationMsMax: duration,
      slowCount: 0,
    };
    state.stages.set(stage, accumulator);
  }
  accumulator.count += 1;
  accumulator.durationMsSum += duration;
  if (duration > accumulator.durationMsMax) {
    accumulator.durationMsMax = duration;
  }
  if (duration >= slowThresholdMs) {
    accumulator.slowCount += 1;
  }
  const units = STAGE_WORK_UNITS.has(stage)
    ? sanitizeRendererPerformanceNumber(workUnits)
    : undefined;
  if (units !== undefined) {
    accumulator.workUnitsSum = (accumulator.workUnitsSum ?? 0) + units;
    accumulator.workUnitsMax = Math.max(accumulator.workUnitsMax ?? 0, units);
  }
}

export function recordRendererPerformanceRafInterval(
  state: RendererPerformanceWindowState,
  intervalMs: unknown,
): void {
  const interval = sanitizeRendererPerformanceNumber(intervalMs);
  if (interval === undefined) {
    return;
  }
  const raf = state.runtime.raf;
  if (!raf) {
    state.runtime.raf = {
      count: 1,
      intervalMsSum: interval,
      intervalMsMax: interval,
      over50msCount: interval > RENDERER_PERFORMANCE_FRAME_ANOMALY_MS ? 1 : 0,
    };
    return;
  }
  raf.count += 1;
  raf.intervalMsSum += interval;
  if (interval > raf.intervalMsMax) {
    raf.intervalMsMax = interval;
  }
  if (interval > RENDERER_PERFORMANCE_FRAME_ANOMALY_MS) {
    raf.over50msCount += 1;
  }
}

export function recordRendererPerformanceTimerDelay(
  state: RendererPerformanceWindowState,
  delayMs: unknown,
): void {
  const delay = sanitizeRendererPerformanceNumber(delayMs);
  if (delay === undefined) {
    return;
  }
  state.runtime.timer = addAggregate(state.runtime.timer, delay);
}

export function recordRendererPerformanceLongTask(
  state: RendererPerformanceWindowState,
  entry: { duration?: unknown },
): void {
  state.observed.longTaskEntries += 1;
  const longTask = (state.runtime.longTask ??= { count: 0 });
  longTask.count += 1;
  const duration = sanitizeRendererPerformanceNumber(entry.duration);
  if (duration !== undefined) {
    longTask.duration = addAggregate(longTask.duration, duration);
  }
}

export function hasRendererPerformanceWindowActivity(
  state: RendererPerformanceWindowState,
): boolean {
  if (state.stages.size > 0) {
    return true;
  }
  const runtime = state.runtime;
  return (
    (runtime.raf?.count ?? 0) > 0 ||
    (runtime.timer?.count ?? 0) > 0 ||
    (runtime.longTask?.count ?? 0) > 0 ||
    (runtime.loaf?.count ?? 0) > 0
  );
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function aggregateMetrics(aggregate: NumberAggregate | undefined): { sum?: number; max?: number } {
  if (!aggregate) {
    return {};
  }
  return { sum: roundTenth(aggregate.sum), max: roundTenth(aggregate.max) };
}

function observerMetrics(
  accumulator: ObserverAccumulator | undefined,
): RendererPerformanceObserverMetrics | undefined {
  if (!accumulator || accumulator.count === 0) {
    return undefined;
  }
  const duration = aggregateMetrics(accumulator.duration);
  return {
    count: accumulator.count,
    ...(duration.sum === undefined ? {} : { durationMsSum: duration.sum }),
    ...(duration.max === undefined ? {} : { durationMsMax: duration.max }),
  };
}

export function buildRendererPerformanceSummary(
  state: RendererPerformanceWindowState,
  windowMs: number,
  capabilities: RendererPerformanceCapabilities,
): RendererPerformanceSummaryV1 | undefined {
  if (!hasRendererPerformanceWindowActivity(state)) {
    return undefined;
  }
  const stages: Partial<Record<RendererPerformanceStage, RendererPerformanceStageMetrics>> = {};
  for (const [stage, accumulator] of state.stages) {
    stages[stage] = {
      count: accumulator.count,
      durationMsSum: roundTenth(accumulator.durationMsSum),
      durationMsMax: roundTenth(accumulator.durationMsMax),
      slowCount: accumulator.slowCount,
      ...(accumulator.workUnitsSum === undefined ? {} : { workUnitsSum: accumulator.workUnitsSum }),
      ...(accumulator.workUnitsMax === undefined ? {} : { workUnitsMax: accumulator.workUnitsMax }),
    };
  }
  const runtime: RendererPerformanceRuntimeMetrics = {};
  if (state.runtime.raf) {
    runtime.raf = {
      count: state.runtime.raf.count,
      intervalMsSum: roundTenth(state.runtime.raf.intervalMsSum),
      intervalMsMax: roundTenth(state.runtime.raf.intervalMsMax),
      over50msCount: state.runtime.raf.over50msCount,
    };
  }
  if (state.runtime.timer && state.runtime.timer.count > 0) {
    runtime.timer = {
      count: state.runtime.timer.count,
      delayMsSum: roundTenth(state.runtime.timer.sum),
      delayMsMax: roundTenth(state.runtime.timer.max),
    };
  }
  const longTask = observerMetrics(state.runtime.longTask);
  if (longTask) {
    runtime.longTask = longTask;
  }
  const loaf = buildRendererPerformanceLoafMetrics(state.runtime.loaf);
  if (loaf) {
    runtime.loaf = loaf;
  }
  return {
    version: 1,
    windowMs,
    stages,
    runtime,
    capabilities: { ...capabilities },
    observed: { ...state.observed },
  };
}
