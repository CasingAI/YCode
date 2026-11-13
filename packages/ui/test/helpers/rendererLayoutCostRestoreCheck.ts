/**
 * restore（切走再切回）逐样本对照。
 *
 * 只接受真实完成态下的滚动记忆恢复：每个变体的每个 measured 样本都必须
 * `|after-before| <= 2px` 且 `firstVisibleTurnId` 与保存前一致；缺少样本或
 * 保存点不在中部都判失败。同时保留 baseline-v-current 不劣的对照。
 */
import type {
  RendererLayoutCostResult,
  RendererLayoutCostSample,
  RendererLayoutCostVariant,
  TimelineSignals,
} from "./rendererLayoutCostTypes.js";

export interface RestoreVariantStats {
  samples: number;
  maxOffsetDeltaPx: number | null;
  allFirstVisibleMatch: boolean | null;
  beforeScrollTopMin: number | null;
}

export interface RestoreComparison {
  prechange: RestoreVariantStats;
  current: RestoreVariantStats;
  prechangeOffsetDeltaPx: number | null;
  currentOffsetDeltaPx: number | null;
  prechangeFirstVisibleMatch: number | null;
  currentFirstVisibleMatch: number | null;
}

function median(values: ReadonlyArray<number | null>): number | null {
  const defined = values.filter((value): value is number => typeof value === "number");
  if (defined.length === 0) return null;
  const sorted = [...defined].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function restoreSamples(
  result: RendererLayoutCostResult,
  variant: RendererLayoutCostVariant,
): RendererLayoutCostSample[] {
  return result.results
    .filter(
      (item) =>
        item.variant === variant &&
        item.caseId === "timeline-restore-away-back" &&
        item.group === "timing",
    )
    .flatMap((item) => item.samples)
    .filter((sample) => sample.mode === "measured");
}

function variantStats(samples: readonly RendererLayoutCostSample[]): {
  stats: RestoreVariantStats;
  deltas: Array<number | null>;
  matches: Array<number | null>;
} {
  const deltas: Array<number | null> = [];
  const matches: Array<number | null> = [];
  let maxDelta: number | null = null;
  let beforeMin: number | null = null;
  let allMatch = true;
  for (const sample of samples) {
    const signals = sample.signals as TimelineSignals;
    const before = (
      signals as unknown as {
        restoreBefore?: { scrollTop?: number; firstVisibleTurnId?: string | null };
      }
    ).restoreBefore;
    if (!before || before.scrollTop == null) {
      deltas.push(null);
      matches.push(null);
      allMatch = false;
      continue;
    }
    beforeMin = beforeMin === null ? before.scrollTop : Math.min(beforeMin, before.scrollTop);
    const afterTop = signals.restore?.scrollTop ?? signals.scrollTop ?? null;
    const delta =
      afterTop === null || before.scrollTop == null ? null : Math.abs(afterTop - before.scrollTop);
    deltas.push(delta);
    if (delta !== null) maxDelta = maxDelta === null ? delta : Math.max(maxDelta, delta);
    const afterTurn = signals.restore?.firstVisibleTurnId ?? signals.firstVisibleTurnId ?? null;
    const match = afterTurn !== null && afterTurn === (before.firstVisibleTurnId ?? null) ? 1 : 0;
    matches.push(match);
    if (match !== 1) allMatch = false;
  }
  return {
    stats: {
      samples: samples.length,
      maxOffsetDeltaPx: maxDelta,
      allFirstVisibleMatch: samples.length > 0 ? allMatch : null,
      beforeScrollTopMin: beforeMin,
    },
    deltas,
    matches,
  };
}

export function restoreComparison(result: RendererLayoutCostResult): RestoreComparison | null {
  const prechange = variantStats(restoreSamples(result, "prechange"));
  const current = variantStats(restoreSamples(result, "current"));
  if (prechange.stats.samples === 0 && current.stats.samples === 0) return null;
  return {
    prechange: prechange.stats,
    current: current.stats,
    prechangeOffsetDeltaPx: median(prechange.deltas),
    currentOffsetDeltaPx: median(current.deltas),
    prechangeFirstVisibleMatch: median(prechange.matches),
    currentFirstVisibleMatch: median(current.matches),
  };
}

/**
 * 严格验收：每变体每样本 delta<=2 且首可见轮一致；保存点必须在中部。
 * baseline-v-current 不劣：current 最大偏移不得超过 prechange 最大偏移 + 2px。
 */
export function restoreProblems(comparison: RestoreComparison | null): string[] {
  if (!comparison) return ["没有可用的 restore 对比样本"];
  const problems: string[] = [];
  for (const [variant, stats] of [
    ["prechange", comparison.prechange],
    ["current", comparison.current],
  ] as const) {
    if (stats.samples === 0) {
      problems.push(`restore 缺少 ${variant} 样本`);
      continue;
    }
    if (stats.maxOffsetDeltaPx === null) {
      problems.push(`restore ${variant} 缺少有效偏移样本`);
    } else if (stats.maxOffsetDeltaPx > 2) {
      problems.push(`restore ${variant} 偏移超过 2px：max=${stats.maxOffsetDeltaPx.toFixed(1)}px`);
    }
    if (stats.allFirstVisibleMatch !== true) {
      problems.push(`restore ${variant} 首可见轮未逐样本一致`);
    }
    if (stats.beforeScrollTopMin !== null && stats.beforeScrollTopMin <= 0) {
      problems.push(`restore ${variant} 保存点不在中部（scrollTop=${stats.beforeScrollTopMin}）`);
    }
  }
  if (
    comparison.current.maxOffsetDeltaPx !== null &&
    comparison.prechange.maxOffsetDeltaPx !== null
  ) {
    if (comparison.current.maxOffsetDeltaPx > comparison.prechange.maxOffsetDeltaPx + 2) {
      problems.push(
        `restore 偏移变差：current max=${comparison.current.maxOffsetDeltaPx} ` +
          `baseline max=${comparison.prechange.maxOffsetDeltaPx}`,
      );
    }
  }
  return problems;
}
