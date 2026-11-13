/**
 * 行为与证据验收。
 *
 * 冒烟只证明 harness 能跑通；正式矩阵额外要求：
 * - 首绘隐藏测量/可见区发布各一次，窗口从 bundle 求值之后开始；
 * - 真实成功的 prepend 让 minRowId 下降、行数与取页增加、inFlight ≤ 1；
 * - restore 切走切回后的偏移与首可见轮不劣于 baseline；
 * - current 侧栏 scroll 热路径的完整几何读取为零或不高于 baseline；
 * - turnCounts（wrapper render，不是 commit）保留到结果里。
 */
import { coverageProblems, type MatrixPlan } from "./rendererLayoutCostCoverage.js";
import {
  restoreComparison,
  restoreProblems,
  type RestoreComparison,
} from "./rendererLayoutCostRestoreCheck.js";
import type {
  CostCounters,
  RendererLayoutCostGroup,
  RendererLayoutCostResult,
  RendererLayoutCostSample,
  RendererLayoutCostVariant,
  SidePaneSignals,
  TimelineSignals,
  ToolbarSignals,
  TurnCounts,
} from "./rendererLayoutCostTypes.js";

export type { RestoreComparison };

export interface AcceptanceReport {
  problems: string[];
  notes: string[];
  restore: RestoreComparison | null;
}

function measured(samples: readonly RendererLayoutCostSample[]): RendererLayoutCostSample[] {
  return samples.filter((sample) => sample.mode === "measured");
}

function samplesOf(
  result: RendererLayoutCostResult,
  variant: RendererLayoutCostVariant,
  caseId: string,
  group: RendererLayoutCostGroup,
): RendererLayoutCostSample[] {
  return measured(
    result.results
      .filter((item) => item.variant === variant && item.caseId === caseId && item.group === group)
      .flatMap((item) => item.samples),
  );
}

function counterOf(sample: RendererLayoutCostSample, key: string): number {
  const counters = sample.counters as CostCounters | null;
  return counters ? (counters.gets[key] ?? counters.gbcr[key] ?? 0) : 0;
}

function checkEventTimingNull(sample: RendererLayoutCostSample, problems: string[]): void {
  const timing = sample.eventTiming;
  if (!timing) return;
  if (!timing.supported) {
    if (timing.inputDelayMs !== null || timing.handlerMs !== null || timing.durationMs !== null) {
      problems.push(`${sample.variant}/${sample.caseId} EventTiming 不支持却给出数值`);
    }
    return;
  }
  if (timing.interactionEntries === 0) {
    if (
      timing.inputDelayMs !== null ||
      timing.handlerMs !== null ||
      timing.presentationMs !== null ||
      timing.durationMs !== null
    ) {
      problems.push(`${sample.variant}/${sample.caseId} 无真实交互条目却出现非 null 数值`);
    }
  }
  if (timing.presentationIsEstimate !== true) {
    problems.push(`${sample.variant}/${sample.caseId} presentation 未标注 estimate`);
  }
}

function checkTurnCounts(
  sample: RendererLayoutCostSample,
  problems: string[],
  notes: string[],
): void {
  const after = sample.turnCounts;
  const before = (sample.signals as unknown as { beforeTurnCounts?: TurnCounts }).beforeTurnCounts;
  if (!before) {
    problems.push(`${sample.variant}/${sample.caseId} 缺少 beforeTurnCounts，无法区分目标轮`);
    return;
  }
  const targets = Object.keys(before).filter((key) => before[key]?.isRunning);
  const target = targets[targets.length - 1] ?? Object.keys(before).pop();
  if (!target) return;
  if (!((after[target]?.count ?? 0) > (before[target]?.count ?? 0))) {
    problems.push(`${sample.variant}/${sample.caseId} 目标轮 wrapper render 未前进`);
  }
  const changedOthers = Object.keys(before).filter(
    (key) => key !== target && (after[key]?.count ?? 0) !== (before[key]?.count ?? 0),
  );
  // 本场景同时滚动与流式更新，其他轮可能因滚动上下文一起重渲染；
  // 「未变轮不得重渲染」只在同会话无关更新场景成立，这里只记录不判失败。
  notes.push(
    changedOthers.length > 0
      ? `${sample.variant}/${sample.caseId} 其他轮也重渲染：${changedOthers.join(", ")}（滚动上下文，不是无关更新判据）`
      : `${sample.variant}/${sample.caseId} 其他可见轮未重渲染`,
  );
  notes.push("turnCounts 是 memo wrapper 的 render 次数，不是 React commit 次数");
}

function basicSmokeChecks(
  result: RendererLayoutCostResult,
  notes: string[],
): { problems: string[] } {
  const problems: string[] = [];
  if (result.results.length === 0) problems.push("没有任何用例被执行");
  for (const caseResult of result.results) {
    for (const sample of measured(caseResult.samples)) {
      checkEventTimingNull(sample, problems);
      if (caseResult.group === "timing" && sample.stepTotalMs === null) {
        problems.push(`${caseResult.variant}/${caseResult.caseId} timing 样本没有 stepTotalMs`);
      }
      if (caseResult.group === "timing" && sample.window && !sample.window.excludesBundleEval) {
        problems.push(`${caseResult.variant}/${caseResult.caseId} 窗口未排除 bundle 求值`);
      }
      if (caseResult.group === "counters" && sample.counters === null) {
        problems.push(`${caseResult.variant}/${caseResult.caseId} counters 样本没有计数`);
      }
    }
  }
  notes.push("冒烟运行只验证 harness 接线，不产出性能收益结论");
  return { problems };
}

function formalCaseChecks(
  result: RendererLayoutCostResult,
  plan: MatrixPlan,
  problems: string[],
  notes: string[],
): void {
  for (const problem of result.meta.buildProblems) problems.push(`构建证据：${problem}`);
  const variants = plan.variants;
  for (const scenario of plan.scenarios) {
    for (const variant of variants) {
      const timing = samplesOf(result, variant, scenario.id, "timing");
      const counters = samplesOf(result, variant, scenario.id, "counters");
      if (timing.length === 0 || counters.length === 0) continue;
      if (timing.some((sample) => !sample.timingEligible)) {
        problems.push(`${variant}/${scenario.id} 存在不满足 fixture 能力的时间样本`);
      }
      for (const sample of timing) {
        if (!sample.window?.excludesBundleEval) {
          problems.push(`${variant}/${scenario.id} 窗口未排除 bundle 求值`);
        }
        if (
          sample.window?.bundleEvalEndMark == null ||
          sample.window.startMark < sample.window.bundleEvalEndMark
        ) {
          problems.push(`${variant}/${scenario.id} 窗口起点早于 bundle 求值结束`);
        }
        checkEventTimingNull(sample, problems);
      }
      const timeline = timing.map((sample) => sample.signals as TimelineSignals);
      const toolbar = timing.map((sample) => sample.signals as ToolbarSignals);
      const sidepane = timing.map((sample) => sample.signals as SidePaneSignals);
      const firstCounters = counters[0]?.counters as CostCounters | undefined;

      if (scenario.id === "timeline-switch-tail") {
        for (const signals of timeline) {
          if (signals.activeIndex !== 0) problems.push(`${variant} 切换后 activeIndex 不是 0`);
          if (signals.sessionId !== "sess-cost-a")
            problems.push(`${variant} 切换后 sessionId 不符`);
          if ((signals.sectionCount ?? 0) <= 0) problems.push(`${variant} 切换后没有可见轮`);
        }
        if (!firstCounters || (firstCounters.gbcr.timeline ?? 0) <= 0) {
          problems.push(`${variant} 未记录到时间线几何读取`);
        }
      }

      if (scenario.id === "timeline-scroll-stream") {
        for (const sample of timing) checkTurnCounts(sample, problems, notes);
      }

      if (scenario.id === "timeline-initial-fill") {
        for (const sample of timing) {
          const signals = sample.signals as TimelineSignals;
          if (signals.firstPaintStaging !== false) problems.push(`${variant} 首绘结束仍在 staging`);
          if ((signals.fill?.pagesFetched ?? 0) < 1) problems.push(`${variant} 首绘未取页`);
          if ((signals.sectionCount ?? 0) < 2) problems.push(`${variant} 首绘可见轮不足`);
          if (signals.stagingPublishCount !== 1) {
            problems.push(
              `${variant} 可见区发布次数=${String(signals.stagingPublishCount)}，要求 1`,
            );
          }
          if ((signals.hiddenLayoutCount ?? 0) < 1) {
            problems.push(`${variant} 未记录到隐藏 staging 测量`);
          }
          if (sample.phases.bundleEvalMs === null || sample.phases.bundleEvalMs <= 0) {
            problems.push(`${variant} 未记录 bundle 求值时间`);
          }
        }
      }

      if (scenario.id === "timeline-prepend-commit") {
        for (const sample of timing) {
          const signals = sample.signals as TimelineSignals;
          const before = (
            signals as unknown as {
              prependBefore?: {
                minRowId?: number | null;
                rowCount?: number | null;
                pagesFetched?: number | null;
                successfulPrependCommits?: number | null;
                olderFillPageCount?: number | null;
                pendingOlder?: number | null;
                inFlight?: number | null;
              };
            }
          ).prependBefore;
          if (!before) {
            problems.push(`${variant} 缺少 prepend 前基线`);
            continue;
          }
          if (
            !(
              (signals.fill?.successfulPrependCommits ?? 0) > (before.successfulPrependCommits ?? 0)
            )
          ) {
            problems.push(`${variant} 没有成功的前插提交（attempt 不算）`);
          }
          if (
            !(
              signals.minRowId != null &&
              before.minRowId != null &&
              signals.minRowId < before.minRowId
            )
          ) {
            problems.push(`${variant} minRowId 未下降，前插未真正扩窗`);
          }
          if (
            !(
              signals.rowCount != null &&
              before.rowCount != null &&
              signals.rowCount > before.rowCount
            )
          ) {
            problems.push(`${variant} 行数未增加`);
          }
          const pagesIncreased = (signals.fill?.pagesFetched ?? 0) > (before.pagesFetched ?? 0);
          const bufferedBefore =
            (before.olderFillPageCount ?? 0) > 0 ||
            before.pendingOlder === 1 ||
            (before.inFlight ?? 0) > 0;
          if (!pagesIncreased && !bufferedBefore) {
            problems.push(`${variant} 前插既未增加取页，窗口内也没有已缓冲的页可提交`);
          }
          if (!(signals.inFlightMax != null && signals.inFlightMax <= 1)) {
            problems.push(`${variant} inFlightMax 缺失或 >1`);
          }
          if ((signals.inFlight ?? 0) !== 0) problems.push(`${variant} 结束时仍有在途补页`);
          if (signals.pendingOlder === true) problems.push(`${variant} 结束时仍有未提交缓冲`);
        }
        const scrolls = counters[0]?.scrolls;
        if (!scrolls) problems.push(`${variant} 缺少滚动来源计数`);
        else {
          if (scrolls.userWheel <= 0) problems.push(`${variant} 未记录到真实 wheel`);
          if (scrolls.userScroll <= 0) problems.push(`${variant} 未区分出用户滚动`);
          // 滚动锚定可能由脚本写 scrollTop 并产生 trusted scroll；分开记录，不混成用户滚动。
          notes.push(
            `${variant} 滚动来源：wheel=${scrolls.userWheel} 用户=${scrolls.userScroll} ` +
              `脚本=${scrolls.scriptScroll} 合成=${scrolls.syntheticScroll}（不相加）`,
          );
        }
      }

      if (scenario.id === "toolbar-width-sweep" || scenario.id === "toolbar-stable-repeat") {
        for (const signals of toolbar) {
          if (signals.controls !== 3) problems.push(`${variant} 工具栏控件数不是 3`);
        }
        if (!firstCounters || firstCounters.toolbarProbeClones <= 0) {
          problems.push(`${variant} 未记录到工具栏探针克隆`);
        }
        // prechange 在稳定宽度下仍会重复写属性；只有 current 必须以零写入通过。
        if (
          variant === "current" &&
          scenario.id === "toolbar-stable-repeat" &&
          (firstCounters?.attributeWrites.toolbar ?? 0) !== 0
        ) {
          problems.push(`${variant} 稳定结果仍有属性写入`);
        }
      }

      if (scenario.id === "sidepane-scroll-hotpath") {
        for (const signals of sidepane) {
          if ((signals.tabs ?? 0) <= 0) problems.push(`${variant} 侧栏没有标签`);
          if (!/^[01]{2}$/.test(signals.mask ?? "")) problems.push(`${variant} mask 不合法`);
        }
        const scrollWidthReads = counters[0] ? counterOf(counters[0], "sidepane.scrollWidth") : 0;
        const clientWidthReads = counters[0] ? counterOf(counters[0], "sidepane.clientWidth") : 0;
        const addRects = firstCounters?.sidepaneAddButtonRects ?? 0;
        if (
          variant === "current" &&
          (scrollWidthReads > 0 || clientWidthReads > 0 || addRects > 0)
        ) {
          problems.push(
            `current 侧栏 scroll 热路径仍有完整几何读取: scrollWidth=${scrollWidthReads} ` +
              `clientWidth=${clientWidthReads} addRects=${addRects}`,
          );
        }
        if (variant === "prechange" && addRects <= 0 && scrollWidthReads <= 0) {
          problems.push("prechange 侧栏滚动未记录到完整几何读取，场景不成立");
        }
      }

      if (scenario.id === "sidepane-overflow-change") {
        for (const signals of sidepane) {
          if ((signals.tabs ?? 0) <= 0) problems.push(`${variant} 侧栏没有标签`);
          if (!/^[01]{2}$/.test(signals.mask ?? "")) problems.push(`${variant} mask 不合法`);
        }
      }
    }
  }

  problems.push(...restoreProblems(restoreComparison(result)));
  notes.push("overflow-change 允许 current 多一次几何测量，作为按钮换位的权衡显式记录");
}

export function validateRendererLayoutCost(
  result: RendererLayoutCostResult,
  plan: MatrixPlan,
): AcceptanceReport {
  const problems = coverageProblems(plan, result.meta.coverage, result.results);
  const notes: string[] = [];
  for (const caseResult of result.results) {
    for (const sample of measured(caseResult.samples)) {
      if (sample.pageErrors.length > 0) {
        problems.push(
          `${sample.variant}/${sample.caseId} 页面错误：${sample.pageErrors.join(" | ")}`,
        );
      }
    }
  }
  if (plan.smoke) {
    const smoke = basicSmokeChecks(result, notes);
    problems.push(...smoke.problems);
  } else {
    formalCaseChecks(result, plan, problems, notes);
  }
  return { problems, notes, restore: restoreComparison(result) };
}
