/**
 * Long Animation Frame 的聚合与摘要。单独成文件，避免把纯聚合层撑成巨文件；
 * 这里仍只处理数值和时间戳，不读取浏览器 API，也不记录脚本来源等真实内容。
 */
import { sanitizeRendererPerformanceNumber } from "./rendererPerformanceDiagnosticsNumbers.js";

export interface RendererPerformanceObserverMetrics {
  count: number;
  durationMsSum?: number;
  durationMsMax?: number;
}

export interface RendererPerformanceLoafMetrics extends RendererPerformanceObserverMetrics {
  blockingDurationMsSum?: number;
  blockingDurationMsMax?: number;
  scriptDurationMsSum?: number;
  scriptDurationMsMax?: number;
  forcedStyleAndLayoutDurationMsSum?: number;
  forcedStyleAndLayoutDurationMsMax?: number;
  renderPhaseMsSum?: number;
  renderPhaseMsMax?: number;
  styleAndLayoutPhaseMsSum?: number;
  styleAndLayoutPhaseMsMax?: number;
}

interface LoafNumberAggregate {
  count: number;
  sum: number;
  max: number;
}

export interface RendererPerformanceLoafAccumulator {
  count: number;
  duration?: LoafNumberAggregate;
  blockingDuration?: LoafNumberAggregate;
  scriptDuration?: LoafNumberAggregate;
  forcedStyleAndLayoutDuration?: LoafNumberAggregate;
  renderPhase?: LoafNumberAggregate;
  styleAndLayoutPhase?: LoafNumberAggregate;
}

export interface RendererPerformanceLoafScript {
  duration?: unknown;
  forcedStyleAndLayoutDuration?: unknown;
}

export interface RendererPerformanceLoafEntry {
  startTime?: unknown;
  duration?: unknown;
  blockingDuration?: unknown;
  renderStart?: unknown;
  styleAndLayoutStart?: unknown;
  scripts?: readonly RendererPerformanceLoafScript[];
}

/** recordRendererPerformanceLoafEntry 只需要 window state 的这两部分。 */
export interface RendererPerformanceLoafState {
  runtime: { loaf?: RendererPerformanceLoafAccumulator };
  observed: { loafEntries: number };
}

type LoafField =
  | "blockingDuration"
  | "scriptDuration"
  | "forcedStyleAndLayoutDuration"
  | "renderPhase"
  | "styleAndLayoutPhase";

function addAggregate(
  aggregate: LoafNumberAggregate | undefined,
  value: number,
): LoafNumberAggregate {
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

function sumScriptField(
  scripts: readonly RendererPerformanceLoafScript[],
  field: "duration" | "forcedStyleAndLayoutDuration",
): number | undefined {
  let sum: number | undefined;
  for (const script of scripts) {
    const value = sanitizeRendererPerformanceNumber(script[field]);
    if (value !== undefined) {
      sum = (sum ?? 0) + value;
    }
  }
  return sum;
}

function addLoafField(
  accumulator: RendererPerformanceLoafAccumulator,
  field: LoafField,
  value: number | undefined,
): void {
  if (value !== undefined) {
    accumulator[field] = addAggregate(accumulator[field], value);
  }
}

export function recordRendererPerformanceLoafEntry(
  state: RendererPerformanceLoafState,
  entry: RendererPerformanceLoafEntry,
): void {
  state.observed.loafEntries += 1;
  const loaf = (state.runtime.loaf ??= { count: 0 });
  loaf.count += 1;

  const duration = sanitizeRendererPerformanceNumber(entry.duration);
  if (duration !== undefined) {
    loaf.duration = addAggregate(loaf.duration, duration);
  }
  addLoafField(loaf, "blockingDuration", sanitizeRendererPerformanceNumber(entry.blockingDuration));

  if (Array.isArray(entry.scripts)) {
    addLoafField(loaf, "scriptDuration", sumScriptField(entry.scripts, "duration"));
    addLoafField(
      loaf,
      "forcedStyleAndLayoutDuration",
      sumScriptField(entry.scripts, "forcedStyleAndLayoutDuration"),
    );
  }

  const startTime = sanitizeRendererPerformanceNumber(entry.startTime);
  const renderStart = sanitizeRendererPerformanceNumber(entry.renderStart);
  const styleAndLayoutStart = sanitizeRendererPerformanceNumber(entry.styleAndLayoutStart);
  if (
    renderStart !== undefined &&
    renderStart > 0 &&
    styleAndLayoutStart !== undefined &&
    styleAndLayoutStart > 0 &&
    styleAndLayoutStart >= renderStart
  ) {
    addLoafField(loaf, "renderPhase", styleAndLayoutStart - renderStart);
  }
  if (styleAndLayoutStart !== undefined && styleAndLayoutStart > 0) {
    const entryEnd =
      startTime !== undefined && duration !== undefined ? startTime + duration : undefined;
    if (entryEnd !== undefined && styleAndLayoutStart <= entryEnd) {
      addLoafField(loaf, "styleAndLayoutPhase", entryEnd - styleAndLayoutStart);
    }
  }
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function aggregateMetrics(aggregate: LoafNumberAggregate | undefined): {
  sum?: number;
  max?: number;
} {
  if (!aggregate) {
    return {};
  }
  return { sum: roundTenth(aggregate.sum), max: roundTenth(aggregate.max) };
}

function observerMetrics(
  accumulator: RendererPerformanceLoafAccumulator,
): RendererPerformanceObserverMetrics {
  const duration = aggregateMetrics(accumulator.duration);
  return {
    count: accumulator.count,
    ...(duration.sum === undefined ? {} : { durationMsSum: duration.sum }),
    ...(duration.max === undefined ? {} : { durationMsMax: duration.max }),
  };
}

export function buildRendererPerformanceLoafMetrics(
  accumulator: RendererPerformanceLoafAccumulator | undefined,
): RendererPerformanceLoafMetrics | undefined {
  if (!accumulator || accumulator.count === 0) {
    return undefined;
  }
  const blocking = aggregateMetrics(accumulator.blockingDuration);
  const script = aggregateMetrics(accumulator.scriptDuration);
  const forced = aggregateMetrics(accumulator.forcedStyleAndLayoutDuration);
  const renderPhase = aggregateMetrics(accumulator.renderPhase);
  const stylePhase = aggregateMetrics(accumulator.styleAndLayoutPhase);
  return {
    ...observerMetrics(accumulator),
    ...(blocking.sum === undefined ? {} : { blockingDurationMsSum: blocking.sum }),
    ...(blocking.max === undefined ? {} : { blockingDurationMsMax: blocking.max }),
    ...(script.sum === undefined ? {} : { scriptDurationMsSum: script.sum }),
    ...(script.max === undefined ? {} : { scriptDurationMsMax: script.max }),
    ...(forced.sum === undefined ? {} : { forcedStyleAndLayoutDurationMsSum: forced.sum }),
    ...(forced.max === undefined ? {} : { forcedStyleAndLayoutDurationMsMax: forced.max }),
    ...(renderPhase.sum === undefined ? {} : { renderPhaseMsSum: renderPhase.sum }),
    ...(renderPhase.max === undefined ? {} : { renderPhaseMsMax: renderPhase.max }),
    ...(stylePhase.sum === undefined ? {} : { styleAndLayoutPhaseMsSum: stylePhase.sum }),
    ...(stylePhase.max === undefined ? {} : { styleAndLayoutPhaseMsMax: stylePhase.max }),
  };
}
