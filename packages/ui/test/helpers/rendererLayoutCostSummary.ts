/**
 * 汇总口径。
 *
 * - timing 组：只统计不 patch getter 的样本；EventTiming 只认 interactionId>0 的真实交互，
 *   缺失保持 null；presentation 是残差估计，不当独立测量。
 * - counters 组：只报计数，不与 timing 组混行，也不用它证明时间收益。
 * - 不同分栏的区间可能嵌套/重叠，只并排展示，不相加。
 */
import type {
  CostCounters,
  EventTimingBreakdown,
  LongTaskBreakdown,
  RendererLayoutCostResult,
  RendererLayoutCostSample,
} from "./rendererLayoutCostTypes.js";

export interface Stats {
  n: number;
  median: number | null;
  p95: number | null;
  max: number | null;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? null;
}

export function stats(values: ReadonlyArray<number | null>): Stats {
  const defined = values.filter((value): value is number => typeof value === "number");
  return {
    n: defined.length,
    median: percentile(defined, 50),
    p95: percentile(defined, 95),
    max: defined.length > 0 ? Math.max(...defined) : null,
  };
}

export interface InteractionTimingStats {
  entries: Stats;
  interactionEntries: Stats;
  inputDelayMs: Stats;
  handlerMs: Stats;
  presentationMs: Stats;
  durationMs: Stats;
  availableSamples: number;
  presentationIsEstimate: true;
  supportedSamples: number;
  thresholdMs: number;
}

const INTERACTION_NAMES = new Set([
  "click",
  "dblclick",
  "keydown",
  "keyup",
  "pointerdown",
  "pointerup",
]);

/**
 * 只接受 interactionId>0 的真实交互；pointerover 等 interactionId=0 条目不能冒充点击。
 * presentation 由 `duration - (processingEnd - startTime)` 得到，是估计残差。
 */
export function summarizeInteractionTiming(
  entries: ReadonlyArray<Record<string, number | string>>,
  supported: boolean,
): EventTimingBreakdown {
  const empty: EventTimingBreakdown = {
    rawEntries: entries.length,
    interactionEntries: 0,
    inputDelayMs: null,
    handlerMs: null,
    presentationMs: null,
    presentationIsEstimate: true,
    durationMs: null,
    thresholdMs: 16,
    supported,
  };
  if (!supported) return empty;
  const interactions = entries.filter((entry) => {
    const interactionId = Number(entry.interactionId);
    if (!(interactionId > 0)) return false;
    const processingStart = Number(entry.processingStart);
    const processingEnd = Number(entry.processingEnd);
    return (
      Number.isFinite(processingStart) && processingStart > 0 && Number.isFinite(processingEnd)
    );
  });
  if (interactions.length === 0) return empty;
  // 同名条目里优先取 click；没有 click 时取处理耗时最长的真实交互。
  const clickable = interactions.filter((entry) => INTERACTION_NAMES.has(String(entry.name)));
  const pool = clickable.length > 0 ? clickable : interactions;
  let pick = pool[0];
  for (const entry of pool) {
    if (Number(entry.duration) > Number(pick.duration)) pick = entry;
  }
  const startTime = Number(pick.startTime);
  const processingStart = Number(pick.processingStart);
  const processingEnd = Number(pick.processingEnd);
  const duration = Number(pick.duration);
  const finiteDuration = Number.isFinite(duration) && duration >= 0 ? duration : null;
  return {
    rawEntries: entries.length,
    interactionEntries: interactions.length,
    inputDelayMs: Math.max(0, processingStart - startTime),
    handlerMs: Math.max(0, processingEnd - processingStart),
    // duration 不可用时残差也无意义，保持 null，不能写成 0。
    presentationMs:
      finiteDuration === null ? null : Math.max(0, finiteDuration - (processingEnd - startTime)),
    presentationIsEstimate: true,
    durationMs: finiteDuration,
    thresholdMs: 16,
    supported,
  };
}

export function summarizeLongTasks(
  entries: ReadonlyArray<{ startTime: number; duration: number }>,
  supported: boolean,
): LongTaskBreakdown {
  if (!supported) {
    return { supported: false, entries: 0, count: null, totalMs: null, maxMs: null };
  }
  let totalMs = 0;
  let maxMs = 0;
  for (const entry of entries) {
    totalMs += entry.duration;
    if (entry.duration > maxMs) maxMs = entry.duration;
  }
  return { supported: true, entries: entries.length, count: entries.length, totalMs, maxMs };
}

export function flattenCounters(counters: CostCounters): Record<string, number> {
  const flat: Record<string, number> = {};
  for (const [key, value] of Object.entries(counters.gbcr)) flat[`gbcr.${key}`] = value;
  for (const [key, value] of Object.entries(counters.gets)) flat[`gets.${key}`] = value;
  for (const [key, value] of Object.entries(counters.sets)) flat[`sets.${key}`] = value;
  for (const [key, value] of Object.entries(counters.attributeWrites)) {
    flat[`attributeWrites.${key}`] = value;
  }
  flat.syntheticScroll = counters.syntheticScroll;
  flat.nativeScroll = counters.nativeScroll;
  flat.userWheel = counters.userWheel;
  flat.userScroll = counters.userScroll;
  flat.scriptScroll = counters.scriptScroll;
  flat.toolbarProbeClones = counters.toolbarProbeClones;
  flat.toolbarProbeAppends = counters.toolbarProbeAppends;
  flat.sidepaneAddButtonRects = counters.sidepaneAddButtonRects;
  return flat;
}

function measured(samples: readonly RendererLayoutCostSample[]): RendererLayoutCostSample[] {
  return samples.filter((sample) => sample.mode === "measured");
}

function timingSummary(samples: readonly RendererLayoutCostSample[]) {
  const events = samples.map((sample) => sample.eventTiming).filter((value) => value !== null);
  const longTasks = samples.map((sample) => sample.longTask).filter((value) => value !== null);
  const supportedLongTasks = longTasks.filter((value) => value.supported);
  return {
    measured: samples.length,
    timingEligible: samples.filter((sample) => sample.timingEligible).length,
    stepTotalMs: stats(samples.map((sample) => sample.stepTotalMs)),
    phases: {
      bundleEvalMs: stats(samples.map((sample) => sample.phases.bundleEvalMs)),
      mountToReadyMs: stats(samples.map((sample) => sample.phases.mountToReadyMs)),
    },
    eventTiming: {
      entries: stats(events.map((entry) => entry.rawEntries)),
      interactionEntries: stats(events.map((entry) => entry.interactionEntries)),
      inputDelayMs: stats(events.map((entry) => entry.inputDelayMs)),
      handlerMs: stats(events.map((entry) => entry.handlerMs)),
      presentationMs: stats(events.map((entry) => entry.presentationMs)),
      durationMs: stats(events.map((entry) => entry.durationMs)),
      availableSamples: events.filter((entry) => entry.interactionEntries > 0).length,
      supportedSamples: events.filter((entry) => entry.supported).length,
      presentationIsEstimate: true as const,
      thresholdMs: 16,
    } satisfies InteractionTimingStats,
    longTask: {
      supportedSamples: supportedLongTasks.length,
      count: stats(supportedLongTasks.map((entry) => entry.count)),
      totalMs: stats(supportedLongTasks.map((entry) => entry.totalMs)),
      maxMs: stats(supportedLongTasks.map((entry) => entry.maxMs)),
    },
    browser: {
      // 缺 perfDeltas 时保持 null；不能把「没测到」写成 0 成本。
      layoutDurationMs: stats(
        samples.map((sample) =>
          sample.perfDeltas ? sample.perfDeltas.LayoutDuration * 1000 : null,
        ),
      ),
      recalcStyleDurationMs: stats(
        samples.map((sample) =>
          sample.perfDeltas ? sample.perfDeltas.RecalcStyleDuration * 1000 : null,
        ),
      ),
      layoutCount: stats(samples.map((sample) => sample.perfDeltas?.LayoutCount ?? null)),
      recalcStyleCount: stats(samples.map((sample) => sample.perfDeltas?.RecalcStyleCount ?? null)),
    },
  };
}

function countersSummary(samples: readonly RendererLayoutCostSample[]) {
  const withCounters = samples.filter((sample) => sample.counters !== null);
  const keys = new Set<string>();
  for (const sample of withCounters) {
    for (const key of Object.keys(flattenCounters(sample.counters!))) keys.add(key);
  }
  const counters: Record<string, Stats> = {};
  for (const key of [...keys].sort()) {
    counters[key] = stats(
      withCounters.map((sample) => {
        const value = flattenCounters(sample.counters!)[key];
        return typeof value === "number" ? value : null;
      }),
    );
  }
  return {
    measured: withCounters.length,
    counters,
  };
}

/** 纯聚合：按 variant/case 输出 timing 与 counters 两组分栏。 */
export function summarizeRendererLayoutCost(result: RendererLayoutCostResult) {
  const groups = new Map<string, RendererLayoutCostSample[]>();
  for (const caseResult of result.results) {
    const key = [caseResult.variant, caseResult.caseId, caseResult.group].join("|");
    const list = groups.get(key) ?? [];
    list.push(...caseResult.samples);
    groups.set(key, list);
  }
  const rows: Array<{
    variant: string;
    surface: string;
    caseId: string;
    group: "timing" | "counters";
    timing?: ReturnType<typeof timingSummary>;
    counters?: ReturnType<typeof countersSummary>;
  }> = [];
  const seen = new Set<string>();
  for (const caseResult of result.results) {
    const key = [caseResult.variant, caseResult.caseId, caseResult.group].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const samples = measured(groups.get(key) ?? []);
    const row = {
      variant: caseResult.variant,
      surface: caseResult.surface,
      caseId: caseResult.caseId,
      group: caseResult.group,
    } as (typeof rows)[number];
    if (caseResult.group === "timing") row.timing = timingSummary(samples);
    else row.counters = countersSummary(samples);
    rows.push(row);
  }
  return {
    samplesPerCase: result.meta.samples,
    warmupsPerCase: result.meta.warmups,
    groups: result.meta.groups,
    smoke: result.meta.smoke,
    frozen: result.meta.frozen,
    coverage: result.meta.coverage,
    note:
      "timing 与 counters 分组独立：counters 组带 getter monkeypatch，其耗时不得用于收益结论；" +
      "中位数 / p95(nearest-rank) / 最大值只描述本受控 fixture；EventTiming 只统计 interactionId>0，" +
      "缺失为 null，presentation 是残差估计；各分栏重叠指标不相加；未复测原完整 YCode 会话",
    rows,
    gaps: result.gaps,
  };
}
