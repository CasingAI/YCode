/** 单个样本的隔离页面交互与指标采集。 */
import type { CDPSession, Page } from "playwright-core";

import type { SampleResult, VariantDefinition } from "./conversationUpdateCostTypes.js";
import { startTimelineTrace } from "./conversationUpdateCostTrace.js";
import { summarizeEventTiming } from "./conversationUpdateCostTrace.js";
import {
  PAGE_SKELETON,
  closeRadixSelect,
  collectTailwindCss,
  openRadixSelect,
  perfDelta,
  readPerf,
  settle,
  waitForReady,
} from "./conversationUpdateCostPage.js";

const STEPS: Array<{
  id: string;
  kind: "session" | "view";
  selector: string;
  index?: number;
  expectedSessionId?: string;
  expectedView?: string;
}> = [
  {
    id: "step-1-session-a",
    kind: "session",
    selector: "cost-session-1",
    index: 0,
    expectedSessionId: "sess-cost-a",
  },
  {
    id: "step-2-session-b",
    kind: "session",
    selector: "cost-session-2",
    index: 1,
    expectedSessionId: "sess-cost-b",
  },
  {
    id: "step-3-session-c",
    kind: "session",
    selector: "cost-session-3",
    index: 2,
    expectedSessionId: "sess-cost-c",
  },
  {
    id: "step-4-session-d",
    kind: "session",
    selector: "cost-session-4",
    index: 3,
    expectedSessionId: "sess-cost-d",
  },
  { id: "step-5-files", kind: "view", selector: "cost-files", expectedView: "files" },
  { id: "step-6-tasks", kind: "view", selector: "cost-tasks", expectedView: "tasks" },
];

export async function runSample(params: {
  page: Page;
  session: CDPSession;
  variant: VariantDefinition;
  sampleIndex: number;
  mode: "warmup" | "measured";
  tailwindCss: string | null;
  bundlePath: string;
  /** 可选的一次独立 trace 组；只在调用方自启的隔离浏览器里启用。 */
  trace?: boolean;
  tracePath?: string;
}): Promise<{ sample: SampleResult; tailwindCss: string | null }> {
  const { page, session, variant, sampleIndex, mode } = params;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.setContent(PAGE_SKELETON);
  await page.evaluate((mode) => {
    globalThis.__COST_DERIVED_MODE__ = mode;
  }, variant.derived);
  await page.addScriptTag({ path: params.bundlePath });
  await waitForReady(page, errors);

  let tailwindCss = params.tailwindCss;
  if (!tailwindCss) {
    tailwindCss = await collectTailwindCss(page);
  }
  await page.addStyleTag({ content: tailwindCss });
  await settle(page, 80);
  await page.evaluate(() => globalThis.__cost.installScrollProbe());
  await page.evaluate(() => globalThis.__cost.startUpdates(40));
  await settle(page, 300);

  await page.evaluate(() => globalThis.__cost.clearMarks());
  const traceCollector =
    params.trace && params.tracePath ? await startTimelineTrace(session, params.tracePath) : null;
  const steps: StepMeasurement[] = [];
  for (const step of STEPS) {
    await page.evaluate((id) => globalThis.__cost.mark(id + ":start"), step.id);
    const perfBefore = await readPerf(session);
    const clickStartedAt = Date.now();
    await page.locator(`[data-testid="${step.selector}"]`).click();
    const clickRoundTripMs = Date.now() - clickStartedAt;
    if (step.kind === "session") {
      await page.waitForFunction(
        (expected) => {
          const host = document.querySelector("[data-cost-host]");
          return host?.getAttribute("data-cost-active-index") === String(expected);
        },
        step.index,
        { timeout: 5_000 },
      );
    } else {
      await page.waitForFunction(
        (expected) => {
          const host = document.querySelector("[data-cost-host]");
          return host?.getAttribute("data-cost-view") === expected;
        },
        step.expectedView,
        { timeout: 5_000 },
      );
    }
    await settle(page, 80);
    const waitAfterClickMs = Date.now() - clickStartedAt - clickRoundTripMs;
    const perfAfter = await readPerf(session);
    await page.evaluate((id) => globalThis.__cost.mark(id + ":end"), step.id);
    const marks = await page.evaluate(() => globalThis.__cost.readMarks());
    const startMark = marks.find((mark) => mark.name === step.id + ":start");
    const endMark = marks.find((mark) => mark.name === step.id + ":end");
    const state = await page.evaluate(() => globalThis.__cost.readViewState());
    const syncEntries = await page.evaluate(() => globalThis.__cost.getSyncEntries());
    const expectedStepKey =
      step.kind === "session" ? `session-${(step.index ?? 0) + 1}` : step.expectedView;
    const syncEntry = syncEntries.find((entry) => entry.step === expectedStepKey);
    const events = await page.evaluate(() => globalThis.__cost.readEvents());
    const longTasks = await page.evaluate(() => globalThis.__cost.readLongTasks());
    const windowStart = startMark ? startMark.t : 0;
    const windowEnd = endMark ? endMark.t : Number.POSITIVE_INFINITY;
    steps.push({
      id: step.id,
      kind: step.kind,
      expectedSessionId: step.expectedSessionId,
      expectedView: step.expectedView,
      mode,
      sampleIndex,
      variantId: variant.id,
      clickRoundTripMs,
      waitAfterClickMs,
      stepTotalMs: Math.max(0, windowEnd - windowStart),
      reactCommitMs: syncEntry ? syncEntry.reactCommitMs : null,
      eventTiming: summarizeEventTiming(
        events.filter((entry) => entry.startTime >= windowStart && entry.startTime < windowEnd),
      ),
      state,
      filesChrome: step.expectedView === "files" ? state.filesChrome : undefined,
      perfDeltas: perfDelta(perfBefore, perfAfter),
      eventEntries: events.filter(
        (entry) => entry.startTime >= windowStart && entry.startTime < windowEnd,
      ),
      longTasks: longTasks.filter(
        (entry) => entry.startTime >= windowStart && entry.startTime < windowEnd,
      ),
    });
  }

  await page.evaluate(() => globalThis.__cost.stopUpdates());
  await settle(page, 120);

  // 派生引用隔离：只更新非活动会话，活动 rows 不变。
  await page.evaluate(() => {
    globalThis.__cost.resetTurnCounts();
    globalThis.__cost.resetTimelineRenders();
    globalThis.__cost.resetDerivedStats();
    globalThis.__cost.pushUpdates(0, 40);
  });
  await settle(page, 120);
  const turnCounts = await page.evaluate(() => globalThis.__cost.readTurnCounts());
  const activeTimelineRenders = await page.evaluate(() => globalThis.__cost.readTimelineRenders());
  const metadataOnlyDerived = await page.evaluate(() => globalThis.__cost.readDerivedStats());
  let completedTurnRenders = 0;
  let runningTurnRenders = 0;
  for (const entry of Object.values(turnCounts)) {
    if (entry.isRunning) runningTurnRenders += entry.count;
    else completedTurnRenders += entry.count;
  }

  // 成员变化：当前实现必须换成新 Set，不能把旧成员集合一直复用。
  await page.evaluate(() => {
    globalThis.__cost.resetDerivedStats();
    globalThis.__cost.toggleMembership();
  });
  await settle(page, 120);
  const membershipDerived = await page.evaluate(() => globalThis.__cost.readDerivedStats());

  // guide item 真实替换：pendingGuides 必须更新；同引用 wrapper 更新则保持稳定。
  await page.evaluate(() => {
    globalThis.__cost.resetDerivedStats();
    globalThis.__cost.swapGuideItem();
  });
  await settle(page, 120);
  const guideSwapDerived = await page.evaluate(() => globalThis.__cost.readDerivedStats());

  // 无前插更新的 scrollTop 几何读取。
  await page.evaluate(() => {
    globalThis.__cost.resetStats();
    globalThis.__cost.pushActiveUpdates(1);
  });
  await settle(page, 120);
  const prependCommit = await page.evaluate(() => globalThis.__cost.readStats());

  // Radix 强制重渲染下的固定样式写入。
  await openRadixSelect(page);
  const radixBefore = await page.evaluate(() => globalThis.__cost.readRadix());
  await page.evaluate(() => {
    globalThis.__cost.resetStats();
    const rerender = globalThis.__costRerenderRadix;
    if (rerender) rerender(100);
  });
  await settle(page, 80);
  const radixStats = await page.evaluate(() => globalThis.__cost.readStats());
  const radixAfter = await page.evaluate(() => globalThis.__cost.readRadix());
  await closeRadixSelect(page);

  // 上翻历史、折叠与滚动恢复。
  await page.evaluate(() => globalThis.__cost.mark("scroll-phase:start"));
  await page.evaluate(() => {
    const timeline = document.querySelector('[data-testid="v4-timeline"]');
    if (timeline)
      timeline.scrollTop = Math.round((timeline.scrollHeight - timeline.clientHeight) * 0.4);
  });
  await settle(page, 200);
  const anchorBefore = await page.evaluate(() => globalThis.__cost.readScrollState());
  await page.evaluate(() => globalThis.__cost.pushActiveUpdates(2));
  await settle(page, 200);
  const anchorAfter = await page.evaluate(() => globalThis.__cost.readScrollState());
  const anchorStable =
    anchorBefore && anchorAfter
      ? Math.abs(anchorAfter.scrollTop - anchorBefore.scrollTop) <= 1 &&
        anchorAfter.firstVisibleTurnId === anchorBefore.firstVisibleTurnId
      : null;

  await page.evaluate(() => globalThis.__cost.startScrollTrace());
  const restoreSetDebug = await page.evaluate(() => {
    const timeline = document.querySelector('[data-testid="v4-timeline"]');
    if (!timeline) return null;
    const max = timeline.scrollHeight - timeline.clientHeight;
    const target = Math.round(max * 0.5);
    const before = timeline.scrollTop;
    timeline.scrollTop = target;
    globalThis.__cost.markScrollTrace("test:set-target");
    return {
      before,
      max,
      target,
      afterImmediate: timeline.scrollTop,
      scrollHeight: timeline.scrollHeight,
      clientHeight: timeline.clientHeight,
    };
  });
  await settle(page, 200);
  await page.evaluate(() => globalThis.__cost.markScrollTrace("test:target-settled"));
  const restoreTargetState = await page.evaluate(() => globalThis.__cost.readScrollState());
  const restoreMemoryAtTarget = await page.evaluate(() => globalThis.__cost.readScrollMemory());
  await page.evaluate(() => globalThis.__cost.markScrollTrace("test:click-session-2"));
  await page.locator('[data-testid="cost-session-2"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-cost-host]")?.getAttribute("data-cost-active-index") === "1",
    undefined,
    { timeout: 5_000 },
  );
  await page.evaluate(() => globalThis.__cost.markScrollTrace("test:session-2-active"));
  await settle(page, 250);
  await page.evaluate(() => globalThis.__cost.markScrollTrace("test:click-session-4"));
  await page.locator('[data-testid="cost-session-4"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-cost-host]")?.getAttribute("data-cost-active-index") === "3",
    undefined,
    { timeout: 5_000 },
  );
  await page.evaluate(() => globalThis.__cost.markScrollTrace("test:session-4-active"));
  await settle(page, 350);
  await page.evaluate(() => globalThis.__cost.markScrollTrace("test:settled"));
  const restoreActualState = await page.evaluate(() => globalThis.__cost.readScrollState());
  const restoreMemoryAtActual = await page.evaluate(() => globalThis.__cost.readScrollMemory());
  const restoreTrace = await page.evaluate(() => globalThis.__cost.stopScrollTrace());
  const restoreTarget = restoreTargetState ? restoreTargetState.scrollTop : null;
  const restoreActual = restoreActualState ? restoreActualState.scrollTop : null;
  const restoreDelta =
    restoreTarget !== null && restoreActual !== null ? restoreActual - restoreTarget : null;

  const historyTrigger = page.locator('[data-testid^="chat-assistant-history-trigger-"]').first();
  let collapseBefore: string | null = null;
  let collapseAfter: string | null = null;
  let collapseScrollDelta: number | null = null;
  let collapseDebug: unknown = null;
  if ((await historyTrigger.count()) > 0) {
    const triggerTestId = await historyTrigger.getAttribute("data-testid");
    await historyTrigger.scrollIntoViewIfNeeded().catch(() => undefined);
    await settle(page, 120);
    collapseBefore = await historyTrigger.getAttribute("data-history-open");
    const collapseScrollBefore = await page.evaluate(() => globalThis.__cost.readScrollState());
    await historyTrigger.click();
    await settle(page, 200);
    collapseAfter = await historyTrigger.getAttribute("data-history-open");
    const collapseScrollAfter = await page.evaluate(() => globalThis.__cost.readScrollState());
    collapseScrollDelta =
      collapseScrollBefore && collapseScrollAfter
        ? collapseScrollAfter.scrollTop - collapseScrollBefore.scrollTop
        : null;
    collapseDebug = await page.evaluate((testId) => {
      const triggers = [
        ...document.querySelectorAll('[data-testid^="chat-assistant-history-trigger-"]'),
      ];
      const target = testId ? document.querySelector('[data-testid="' + testId + '"]') : null;
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          testid: element.getAttribute("data-testid"),
          open: element.getAttribute("data-history-open"),
          state: element.closest("[data-state]")?.getAttribute("data-state") ?? null,
          disabled: Boolean(element.disabled),
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        };
      };
      return {
        triggerTestId: testId,
        count: triggers.length,
        targetState: target
          ? (target.closest("[data-state]")?.getAttribute("data-state") ?? null)
          : null,
        targetOpen: target ? target.getAttribute("data-history-open") : null,
        triggers: triggers.slice(0, 6).map(describe),
        activeElement: document.activeElement ? document.activeElement.tagName : null,
      };
    }, triggerTestId);
    await historyTrigger.click();
    await settle(page, 150);
  }

  const events = await page.evaluate(() => globalThis.__cost.readEvents());
  const longTasks = await page.evaluate(() => globalThis.__cost.readLongTasks());
  const syncEntries = await page.evaluate(() => globalThis.__cost.getSyncEntries());
  const traceResult = traceCollector ? await traceCollector.stop() : null;

  return {
    tailwindCss,
    sample: {
      variantId: variant.id,
      sampleIndex,
      mode,
      derivedMode: variant.derived,
      pageErrors: errors,
      steps,
      derived: {
        completedTurnRenders,
        runningTurnRenders,
        activeTimelineRenders,
        timelineRenders: activeTimelineRenders,
        metadataOnly: metadataOnlyDerived,
        membership: membershipDerived,
        guideSwap: guideSwapDerived,
      },
      prependCommit,
      radix: {
        contentOpen: radixBefore.contentOpen,
        forcedRerenders: 100,
        styleInnerHtml: radixStats.styleInnerHtml,
        anyInnerHtml: radixStats.anyInnerHtml,
        beforeStyleCount: radixBefore.styleCount,
        afterStyleTextLengths: radixAfter.styleTextLengths,
      },
      scroll: {
        anchorBefore: anchorBefore
          ? {
              scrollTop: anchorBefore.scrollTop,
              firstVisibleTurnId: anchorBefore.firstVisibleTurnId,
            }
          : null,
        anchorAfter: anchorAfter
          ? { scrollTop: anchorAfter.scrollTop, firstVisibleTurnId: anchorAfter.firstVisibleTurnId }
          : null,
        anchorStable,
        collapseBeforeExpanded: collapseBefore,
        collapseAfterExpanded: collapseAfter,
        collapseToggled:
          collapseBefore !== null && collapseAfter !== null
            ? collapseBefore !== collapseAfter
            : null,
        collapseScrollDelta,
        collapseDebug,
        restoreTarget,
        restoreActual,
        restoreDelta,
        restoreTargetVisibleTurnId: restoreTargetState
          ? restoreTargetState.firstVisibleTurnId
          : null,
        restoreActualVisibleTurnId: restoreActualState
          ? restoreActualState.firstVisibleTurnId
          : null,
        restoreSetDebug,
        restoreMemory: { atTarget: restoreMemoryAtTarget, atActual: restoreMemoryAtActual },
        restoreTrace,
      },
      events,
      longTasks,
      syncEntries,
      trace: traceResult
        ? {
            outputPath: traceResult.outputPath,
            categories: traceResult.categories,
            durationMs: traceResult.durationMs,
            eventCount: traceResult.eventCount,
            ...traceResult.metrics,
          }
        : undefined,
    },
  };
}
