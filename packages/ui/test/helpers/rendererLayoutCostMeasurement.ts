/**
 * 单次采样：先分离 bundle 求值，再打开场景窗口。
 *
 * 旧实现把 `startMark` 设为页面 bootAt 且在 `addScriptTag` 之前取 `perfBefore`，
 * 于是 38.5MB bundle 的编译/注入（约 2.7s longtask）被算进 initial-fill。这里：
 * 1. addScriptTag 单独计时为 `bundleEvalMs`，不计入 stepTotal；
 * 2. bundle 求值后才注入探针、读取 `perfBefore`、标记窗口起点；
 * 3. 窗口终点由场景的“最后可观察完成”决定，不使用固定 settle。
 */
import { performance } from "node:perf_hooks";
import type { CDPSession, Page } from "playwright-core";

import type { BuiltBundle } from "./rendererLayoutCostBuild.js";
import { LAYOUT_COST_PAGE_SKELETON } from "./rendererLayoutCostFixture.js";
import { PRODUCT_CSS_STYLE_ATTRIBUTE } from "./rendererLayoutCostFixtureCss.js";
import { readPerf } from "./conversationUpdateCostPage.js";
import {
  mountSurface,
  nextPaint,
  readFixtureCapabilities,
  readSurfaceState,
  waitForSurfaceReady,
} from "./rendererLayoutCostPageSignals.js";
import {
  rendererLayoutCostProbeScript,
  type RendererLayoutCostProbeMode,
} from "./rendererLayoutCostProbes.js";
import type { RendererLayoutCostScenario } from "./rendererLayoutCostScenarios.js";
import { summarizeInteractionTiming, summarizeLongTasks } from "./rendererLayoutCostSummary.js";
import type {
  CostCounters,
  RendererLayoutCostGroup,
  RendererLayoutCostMode,
  RendererLayoutCostSample,
  ScrollTrustBreakdown,
  TurnCounts,
} from "./rendererLayoutCostTypes.js";

export interface MeasureSampleParams {
  page: Page;
  session: CDPSession;
  scenario: RendererLayoutCostScenario;
  bundle: BuiltBundle;
  sampleIndex: number;
  mode: RendererLayoutCostMode;
  group: RendererLayoutCostGroup;
}

async function mark(page: Page, name: string): Promise<number> {
  return page.evaluate((markName) => {
    const probe = (globalThis as { __probe: { mark(name: string): number } }).__probe;
    return probe.mark(markName);
  }, name);
}

/** 窗口终点：记录标记并立刻冻结计数，后续空闲帧不进入 counters。 */
async function markEnd(page: Page, name: string): Promise<number> {
  return page.evaluate((markName) => {
    const probe = (
      globalThis as {
        __probe: { mark(name: string): number; freeze?: () => void };
      }
    ).__probe;
    const t = probe.mark(markName);
    if (probe.freeze) probe.freeze();
    return t;
  }, name);
}

async function readMark(page: Page, name: string): Promise<number | null> {
  return page.evaluate((markName) => {
    const probe = (
      globalThis as {
        __probe: { readMarks(): Array<{ name: string; t: number }> };
      }
    ).__probe;
    const found = probe.readMarks().find((item) => item.name === markName);
    return found ? found.t : null;
  }, name);
}

function scrollTrustOf(counters: CostCounters): ScrollTrustBreakdown {
  return {
    userWheel: counters.userWheel,
    userScroll: counters.userScroll,
    scriptScroll: counters.scriptScroll,
    syntheticScroll: counters.syntheticScroll,
    nativeScroll: counters.nativeScroll,
  };
}

async function startInitialFill(
  page: Page,
  scenario: RendererLayoutCostScenario,
): Promise<boolean> {
  return page.evaluate(
    (payload) => {
      const scope = globalThis as unknown as {
        __probe: { mark(name: string): void };
        __costTimeline?: { mount?: () => void };
        __costToolbar?: { mount?: () => void };
        __costSidePane?: { mount?: () => void };
      };
      const scoped =
        payload.surface === "timeline"
          ? scope.__costTimeline
          : payload.surface === "toolbar"
            ? scope.__costToolbar
            : scope.__costSidePane;
      // 窗口起点重置计数与标记：只统计 mount 及之后的成本。
      scope.__probe.reset();
      scope.__probe.mark(payload.id + ":start");
      if (!scoped || typeof scoped.mount !== "function") return false;
      scoped.mount();
      return true;
    },
    { id: scenario.id, surface: scenario.surface },
  );
}

export async function measureSample(
  params: MeasureSampleParams,
): Promise<RendererLayoutCostSample> {
  const { page, session, scenario, bundle, sampleIndex, mode, group } = params;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));

  await page.setContent(LAYOUT_COST_PAGE_SKELETON);

  // 1) bundle 求值单独计时；产品 CSS 由 bundle 入口在 mount 之前注入。
  const evalStartedAt = performance.now();
  await page.addScriptTag({ path: bundle.bundlePath });
  const bundleEvalMs = performance.now() - evalStartedAt;
  const bundleEvalEndMark = await page.evaluate(() => performance.now());
  const productCssInstalled = await page.evaluate(
    (attribute) => document.head?.querySelector(`[${attribute}]`) !== null,
    PRODUCT_CSS_STYLE_ATTRIBUTE,
  );
  if (!productCssInstalled) errors.push("bundle 求值后未注入静态产品 CSS");

  // 2) 探针在 bundle 之后、mount 之前注入，bundle 的解析/编译 longtask 不会进入窗口。
  await page.evaluate(rendererLayoutCostProbeScript(group as RendererLayoutCostProbeMode));
  await page.evaluate("globalThis.__probe.reset()");
  const capabilities = await readFixtureCapabilities(page);
  const probeSupport = (await page.evaluate(() => {
    const probe = (globalThis as { __probe: { supported(): Record<string, boolean> } }).__probe;
    return probe.supported();
  })) as { event?: boolean; longTask?: boolean; counters?: boolean };

  let startMark: number | null = null;
  let endMark: number | null = null;
  let perfBefore: Record<string, number> | null = null;

  if (scenario.mountIsOperation) {
    if (group === "timing") perfBefore = await readPerf(session);
    const mounted = await startInitialFill(page, scenario);
    if (!mounted) {
      // 旧 fixture 在 bundle 求值时已自动挂载；保留窗口但该样本不可用于时间结论。
      startMark = await mark(page, scenario.id + ":start");
    } else {
      startMark = await readMark(page, scenario.id + ":start");
    }
    await scenario.waitDone(page);
  } else {
    // 挂载与预热都在窗口外；它们只把场景推到稳态，不产生被测操作的时间。
    await mountSurface(page, scenario.surface);
    await waitForSurfaceReady(page, scenario.surface);
    if (scenario.warm) await scenario.warm(page);
    else await nextPaint(page);
    // 挂载与预热的读取/计数都在窗口外；从这里重新起算。
    await page.evaluate("globalThis.__probe.reset()");
    if (group === "timing") perfBefore = await readPerf(session);
    startMark = await mark(page, scenario.id + ":start");
    await scenario.start(page);
    await scenario.waitDone(page);
  }

  endMark = await markEnd(page, scenario.id + ":end");
  // 浏览器计数器在窗口终点读取，避免把之后的两帧也计进 perf delta。
  const perfAfter = group === "timing" ? await readPerf(session) : null;
  // 只为了让 EventTiming / longtask 观察器投递条目；这两帧在窗口之外。
  await nextPaint(page);

  const events =
    group === "timing"
      ? ((await page.evaluate("globalThis.__probe.readEvents()")) as Array<
          Record<string, number | string>
        >)
      : [];
  const longTasks =
    group === "timing"
      ? ((await page.evaluate("globalThis.__probe.readLongTasks()")) as Array<{
          startTime: number;
          duration: number;
        }>)
      : [];
  const counters =
    group === "counters"
      ? ((await page.evaluate("globalThis.__probe.read()")) as CostCounters)
      : null;
  const state = await readSurfaceState(page, scenario.surface);
  const turnCounts =
    (state.turnCounts as TurnCounts | undefined) ??
    ((await page.evaluate(() => {
      const scoped = (globalThis as { __costTimeline?: { turnCounts?: () => TurnCounts } })
        .__costTimeline;
      return scoped && typeof scoped.turnCounts === "function" ? scoped.turnCounts() : {};
    })) as TurnCounts);

  const windowEvents =
    startMark !== null && endMark !== null
      ? events.filter((entry) => {
          const startTime = Number(entry.startTime);
          return startTime >= startMark! && startTime < endMark!;
        })
      : [];
  const windowLongTasks =
    startMark !== null && endMark !== null
      ? longTasks.filter((entry) => entry.startTime >= startMark! && entry.startTime < endMark!)
      : [];

  const missingCapabilities = scenario.requiredCapabilities.filter(
    (name) => !capabilities.capabilities.includes(name),
  );
  const timingEligible =
    group === "timing" &&
    missingCapabilities.length === 0 &&
    (!scenario.mountIsOperation || capabilities.deferredMount);
  const stepTotalMs =
    group === "timing" && startMark !== null && endMark !== null
      ? Math.max(0, endMark - startMark)
      : null;

  return {
    variant: bundle.variant,
    surface: scenario.surface,
    caseId: scenario.id,
    sampleIndex,
    mode,
    group,
    timingEligible,
    fixtureCapabilities: capabilities.capabilities,
    phases: {
      bundleEvalMs,
      mountToReadyMs: scenario.mountIsOperation ? stepTotalMs : null,
    },
    window:
      startMark !== null && endMark !== null
        ? {
            startMark,
            endMark,
            bundleEvalEndMark,
            excludesBundleEval: startMark >= bundleEvalEndMark,
            completion: scenario.completion,
          }
        : null,
    stepTotalMs,
    eventTiming:
      group === "timing"
        ? summarizeInteractionTiming(windowEvents, probeSupport.event === true)
        : null,
    perfDeltas:
      group === "timing" && perfBefore && perfAfter
        ? {
            LayoutCount: (perfAfter.LayoutCount ?? 0) - (perfBefore.LayoutCount ?? 0),
            RecalcStyleCount:
              (perfAfter.RecalcStyleCount ?? 0) - (perfBefore.RecalcStyleCount ?? 0),
            LayoutDuration: (perfAfter.LayoutDuration ?? 0) - (perfBefore.LayoutDuration ?? 0),
            RecalcStyleDuration:
              (perfAfter.RecalcStyleDuration ?? 0) - (perfBefore.RecalcStyleDuration ?? 0),
            TaskDuration: (perfAfter.TaskDuration ?? 0) - (perfBefore.TaskDuration ?? 0),
            ScriptDuration: (perfAfter.ScriptDuration ?? 0) - (perfBefore.ScriptDuration ?? 0),
          }
        : null,
    longTask:
      group === "timing"
        ? summarizeLongTasks(windowLongTasks, probeSupport.longTask === true)
        : null,
    counters,
    scrolls: counters ? scrollTrustOf(counters) : null,
    signals: state as RendererLayoutCostSample["signals"],
    turnCounts,
    pageErrors: errors,
  };
}
