/**
 * 会话更新成本结果的纯聚合：单位换算、动态样本说明与分栏。
 *
 * CDP `Performance.getMetrics` 的 Duration 指标（LayoutDuration、RecalcStyleDuration、
 * TaskDuration、ScriptDuration）原始单位是**秒**，不是毫秒。这里统一乘 1000 后再以
 * `*Ms` 命名；Duration 指标彼此嵌套（TaskDuration 覆盖 Script/Layout/Recalc），
 * trace 指标也与它们重叠，因此只分栏展示，绝不相加。
 */
import type {
  ConversationUpdateCostResult,
  SampleResult,
  VariantResult,
} from "./conversationUpdateCostTypes.js";

/** CDP Performance.getMetrics 中单位为秒的字段。 */
export const CDP_DURATION_FIELDS = [
  "LayoutDuration",
  "RecalcStyleDuration",
  "TaskDuration",
  "ScriptDuration",
] as const;

export type CdpDurationField = (typeof CDP_DURATION_FIELDS)[number];

/**
 * CDP Duration 原始值（秒）换算为毫秒；缺失或非法值按 0 填充。
 * 0 只用于保持聚合形状，不作为“指标存在”或“实际耗时为 0”的证据。
 */
export function cdpSecondsToMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : 0;
}

export function stepDurationMs(
  steps: ReadonlyArray<{ perfDeltas: Record<string, number> }>,
  field: CdpDurationField,
): number[] {
  return steps.map((step) => cdpSecondsToMs(step.perfDeltas[field]));
}

export function measuredSamples(variant: VariantResult): SampleResult[] {
  return variant.samples.filter((sample) => sample.mode === "measured");
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function medianDefined(values: ReadonlyArray<number | null>): number | null {
  return median(values.filter((value): value is number => typeof value === "number"));
}

export function turnOrdinal(turnId: string | null | undefined): number | null {
  const match = typeof turnId === "string" ? /-turn-(\d+)$/.exec(turnId) : null;
  return match ? Number(match[1]) : null;
}

export function restoreTurnShift(sample: SampleResult): number | null {
  const target = turnOrdinal(sample.scroll.restoreTargetVisibleTurnId);
  const actual = turnOrdinal(sample.scroll.restoreActualVisibleTurnId);
  return target !== null && actual !== null ? actual - target : null;
}

function distinct(values: readonly number[]): string {
  return [...new Set(values)].sort((left, right) => left - right).join("/");
}

/**
 * 样本说明必须来自实际 meta/变体，而不是写死“1 预热 + 3 measured”。
 * 配对运行是 0 预热 + 1 measured，矩阵运行是 1 + 3；同一 helper 两者都要准确。
 */
export function buildStatisticalNote(
  meta: { warmupPerVariant: number; samplesPerVariant: number },
  variants: readonly Pick<VariantResult, "samples">[],
): string {
  const observed = variants.map((variant) => {
    const measured = variant.samples.filter((sample) => sample.mode === "measured").length;
    return { warmup: variant.samples.length - measured, measured };
  });
  const warmupText =
    observed.length > 0
      ? distinct(observed.map((entry) => entry.warmup))
      : String(meta.warmupPerVariant);
  const measuredText =
    observed.length > 0
      ? distinct(observed.map((entry) => entry.measured))
      : String(meta.samplesPerVariant);
  return (
    `每变体 ${warmupText} 次预热 + ${measuredText} 次 measured` +
    `（meta: warmup=${meta.warmupPerVariant}, measured=${meta.samplesPerVariant}）；` +
    "中位数只描述该受控场景，不足以做显著性结论"
  );
}

export function summarizeConversationUpdateCost(result: ConversationUpdateCostResult) {
  const variants = result.variants.map((variant) => {
    const samples = measuredSamples(variant);
    const steps = samples.flatMap((sample) => sample.steps);
    const stepTotal = steps.map((step) => step.stepTotalMs);
    const clickRoundTrip = steps.map((step) => step.clickRoundTripMs);
    const reactCommit = steps
      .map((step) => step.reactCommitMs)
      .filter((value): value is number => typeof value === "number");
    const layout = steps.map((step) => step.perfDeltas.LayoutCount ?? 0);
    const recalc = steps.map((step) => step.perfDeltas.RecalcStyleCount ?? 0);
    // CDP Duration 原始为秒；这里先换算成毫秒再进入 summary，字段名与数值单位一致。
    const layoutDuration = stepDurationMs(steps, "LayoutDuration");
    const recalcStyleDuration = stepDurationMs(steps, "RecalcStyleDuration");
    const taskDuration = stepDurationMs(steps, "TaskDuration");
    const scriptDuration = stepDurationMs(steps, "ScriptDuration");
    const longTaskCount = samples.map((sample) => sample.longTasks.length);
    const longTaskTotalMs = samples.map((sample) =>
      sample.longTasks.reduce((sum, entry) => sum + entry.duration, 0),
    );
    const inputDelay = steps.map((step) => step.eventTiming.inputDelayMs);
    const handler = steps.map((step) => step.eventTiming.handlerMs);
    const presentation = steps.map((step) => step.eventTiming.presentationMs);
    const eventDuration = steps.map((step) => step.eventTiming.durationMs);
    return {
      id: variant.definition.id,
      buildKey: variant.buildKey,
      derivedMode: variant.definition.derived,
      degenerate: variant.degenerate,
      buildMs: variant.buildMs,
      measuredSamples: samples.length,
      warmupSamples: variant.samples.length - samples.length,
      // automation 与 EventTiming 分栏；stepTotal 只含自动化往返与固定 settle，不是产品延迟。
      automation: {
        clickRoundTripMs: median(clickRoundTrip),
        fixedWaitAndProbeMs: median(steps.map((step) => step.waitAfterClickMs)),
        harnessStepTotalMs: median(stepTotal),
        // flushSync 包围 render+DOM commit+layout；不是 Profiler 的纯 commit 时长。
        synchronousReactUpdateEnvelopeMs: median(reactCommit),
      },
      eventTiming: {
        availableSteps: steps.filter((step) => step.eventTiming.durationMs !== null).length,
        totalSteps: steps.length,
        inputDelayMs: medianDefined(inputDelay),
        handlerMs: medianDefined(handler),
        presentationMs: medianDefined(presentation),
        durationMs: medianDefined(eventDuration),
      },
      browser: {
        layoutCountPerStep: median(layout),
        recalcStyleCountPerStep: median(recalc),
        // 以下四项均为 ms：CDP 原始秒值已乘 1000。
        layoutDurationMsPerStep: median(layoutDuration),
        recalcStyleDurationMsPerStep: median(recalcStyleDuration),
        taskDurationMsPerStep: median(taskDuration),
        scriptDurationMsPerStep: median(scriptDuration),
        longTasksPerSample: median(longTaskCount),
        longTaskTotalMsPerSample: median(longTaskTotalMs),
        durationUnitNote:
          "CDP Duration 原始单位为秒，browser.*DurationMsPerStep 已乘 1000 换算为毫秒；TaskDuration 覆盖 Script/Recalc/Layout，彼此嵌套且与 trace 重叠，不相加",
      },
      ranges: {
        stepTotalMs: [Math.min(...stepTotal), Math.max(...stepTotal)],
        synchronousReactUpdateEnvelopeMs:
          reactCommit.length > 0 ? [Math.min(...reactCommit), Math.max(...reactCommit)] : null,
        eventDurationMs: eventDuration.some((value) => value !== null)
          ? [
              Math.min(...eventDuration.filter((value): value is number => value !== null)),
              Math.max(...eventDuration.filter((value): value is number => value !== null)),
            ]
          : null,
      },
      static: {
        timelineScrollTopGets: samples.map((sample) => sample.prependCommit.timelineScrollTopGets),
        radixStyleInnerHtml: samples.map((sample) => sample.radix.styleInnerHtml),
        completedTurnRenders: samples.map((sample) => sample.derived.completedTurnRenders),
        inactiveTimelineRenders: samples.map((sample) => sample.derived.activeTimelineRenders),
        derivedStats: samples.map((sample) => ({
          metadataOnly: sample.derived.metadataOnly,
          membership: sample.derived.membership,
          guideSwap: sample.derived.guideSwap,
        })),
      },
      knownRestoreDrift: samples.map((sample) => ({
        knownIssue: true,
        target: sample.scroll.restoreTarget,
        actual: sample.scroll.restoreActual,
        delta: sample.scroll.restoreDelta,
        targetVisibleTurnId: sample.scroll.restoreTargetVisibleTurnId ?? null,
        actualVisibleTurnId: sample.scroll.restoreActualVisibleTurnId ?? null,
        turnShift: restoreTurnShift(sample),
      })),
      scroll: samples.map((sample) => sample.scroll),
    };
  });
  return {
    samplesPerVariant: result.meta.samplesPerVariant,
    warmupPerVariant: result.meta.warmupPerVariant,
    statisticalNote: buildStatisticalNote(result.meta, result.variants),
    metricNote:
      "automation、EventTiming、CDP Performance 与 trace 各自分栏，互不相加；" +
      "CDP Duration 原始为秒，browser.*DurationMsPerStep 已换算为毫秒；" +
      "synchronousReactUpdateEnvelopeMs 是 flushSync 包围 render+DOM+layout 的同步更新耗时，不是 Profiler commit；" +
      "EventTiming duration 是所选单个事件的总时长，不等于 INP（INP 需按 input delay + processing time + presentation delay 独立采集）",
    fixtureCostNote:
      "fixture 把基线与当前构建的 conversationTimelineDebug 模块都替换为 no-op；对照只覆盖几何读取、DOM 写入与派生引用，不含真实 logger/timer 成本",
    knownIssues: [
      "虚拟列表测高后的滚动恢复 drift 在 baseline 与修复变体同源存在；这里只要求修复不劣于 baseline，不把 drift 当作正确语义",
    ],
    variants,
    traces: result.traces ?? [],
  };
}
