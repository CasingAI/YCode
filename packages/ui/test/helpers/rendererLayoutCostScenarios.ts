/**
 * 用例定义：每个 case 都有明确的窗口起点、最后可观察完成判据和轻量等待信号。
 *
 * 窗口内不使用固定 settle；`nextPaint` 只等待一次绘制作为“最后可观察完成”，
 * 与原先每步 150ms 的兜底等待不同。完成判定优先读 fixture 的 `signals()`，
 * 避免在时间窗口内调用会读几何的 `read()`。
 */
import type { Page } from "playwright-core";

import {
  nextPaint,
  readSurfaceState,
  waitForTimelineReady,
} from "./rendererLayoutCostPageSignals.js";
import type {
  RendererLayoutCostGroup,
  RendererLayoutCostSurface,
  TimelineSignals,
} from "./rendererLayoutCostTypes.js";
import { UI_SCENARIOS } from "./rendererLayoutCostScenariosUi.js";

export interface RendererLayoutCostScenario {
  id: string;
  surface: RendererLayoutCostSurface;
  groups: RendererLayoutCostGroup[];
  /** mount 本身就是被测操作（首绘）：窗口从 mount 调用开始。 */
  mountIsOperation?: boolean;
  /** mount 之后、窗口之前把场景推到稳态。 */
  warm?: (page: Page) => Promise<void>;
  /** 窗口开始后的操作；可包含真实滚轮与多步交互。 */
  start: (page: Page) => Promise<void>;
  /** 等到最后可观察完成；不得使用固定 settle。 */
  waitDone: (page: Page) => Promise<void>;
  read: (page: Page) => Promise<Record<string, unknown>>;
  completion: string;
  /** 正式矩阵要求 fixture 具备的能力；缺失时只能做冒烟并标记时间不可用。 */
  requiredCapabilities: string[];
}

declare global {
  // eslint-disable-next-line no-var
  var __costTimeline: {
    switchTo(index: number): void;
    scrollRatio(ratio: number): void;
    pushActive(count: number): void;
    turnCounts(): Record<string, { count: number; isRunning: boolean }>;
  };
  // eslint-disable-next-line no-var
  var __costPrependBefore: Record<string, number | null> | undefined;
  // eslint-disable-next-line no-var
  var __costRestoreBefore: Record<string, number | string | null> | undefined;
  // eslint-disable-next-line no-var
  var __costBeforeTurnCounts: Record<string, { count: number; isRunning: boolean }> | undefined;
}

const timelineRead = (page: Page) => readSurfaceState(page, "timeline");

/**
 * 切回后的完成判据：fixture 报告 restore 落点即结束。
 * 缺 signals 的旧 fixture 退回一帧；能力缺失由验收标记，不把固定等待当完成。
 */
async function waitForRestoreApplied(page: Page): Promise<void> {
  const hasSignals = await page.evaluate(
    () =>
      typeof (globalThis as { __costTimeline?: { signals?: () => unknown } }).__costTimeline
        ?.signals === "function",
  );
  if (!hasSignals) {
    await nextPaint(page);
    return;
  }
  try {
    await page.waitForFunction(
      () => {
        const scoped = globalThis.__costTimeline as unknown as {
          signals?: () => TimelineSignals;
        };
        const signals = scoped.signals?.();
        return Boolean(signals && signals.restore != null);
      },
      undefined,
      { timeout: 5_000, polling: "raf" },
    );
  } catch {
    // 该 fixture 没有 restore 信号：窗口仍结束，验收会按缺失能力失败。
  }
}

const timelineSwitchTail: RendererLayoutCostScenario = {
  id: "timeline-switch-tail",
  surface: "timeline",
  groups: ["timing", "counters"],
  warm: (page) => waitForTimelineReady(page),
  start: async (page) => {
    await page.evaluate(() => globalThis.__costTimeline.switchTo(0));
  },
  waitDone: async (page) => {
    await page.waitForFunction(
      () => {
        const host = document.querySelector("[data-cost-host]");
        const timeline = document.querySelector('[data-testid="v4-timeline"]');
        if (host?.getAttribute("data-cost-active-index") !== "0") return false;
        if (host.getAttribute("data-cost-ready") !== "1") return false;
        if (timeline?.querySelector("[data-v4-timeline-first-paint-staging]")) return false;
        return (timeline?.querySelectorAll("section[data-turn-id]").length ?? 0) > 0;
      },
      undefined,
      { timeout: 20_000, polling: "raf" },
    );
  },
  read: timelineRead,
  completion: "切换会话后目标会话可见且首绘 staging 已撤下",
  requiredCapabilities: ["timeline.signals"],
};

const timelineScrollStream: RendererLayoutCostScenario = {
  id: "timeline-scroll-stream",
  surface: "timeline",
  groups: ["timing", "counters"],
  warm: (page) => waitForTimelineReady(page),
  start: async (page) => {
    await page.evaluate(() => {
      // fixture 的 turnCounts() 返回内部 entry 引用；必须克隆数字，
      // 否则 before 会随 wrapper 渲染一起变化，永远看不出目标轮前进。
      globalThis.__costBeforeTurnCounts = Object.fromEntries(
        Object.entries(globalThis.__costTimeline.turnCounts()).map(([key, value]) => [
          key,
          { count: value.count, isRunning: value.isRunning },
        ]),
      );
      globalThis.__costTimeline.scrollRatio(0.9);
      globalThis.__costTimeline.pushActive(3);
      globalThis.__costTimeline.scrollRatio(1);
    });
  },
  waitDone: async (page) => {
    try {
      await page.waitForFunction(
        () => {
          const scoped = globalThis.__costTimeline as unknown as {
            turnCounts: () => Record<string, { count: number; isRunning: boolean }>;
          };
          const before = globalThis.__costBeforeTurnCounts;
          const after = scoped.turnCounts();
          if (!before) return false;
          const running = Object.keys(before).filter((key) => before[key]?.isRunning);
          const target = running[running.length - 1] ?? Object.keys(before).pop();
          if (!target) return true;
          return (after[target]?.count ?? 0) > (before[target]?.count ?? 0);
        },
        undefined,
        { timeout: 20_000, polling: "raf" },
      );
    } catch (error) {
      const diagnostic = await page.evaluate(() => {
        const scoped = globalThis.__costTimeline as unknown as {
          turnCounts: () => Record<string, { count: number; isRunning: boolean }>;
        };
        return {
          before: globalThis.__costBeforeTurnCounts ?? null,
          after: scoped.turnCounts(),
          sections: document
            .querySelector('[data-testid="v4-timeline"]')
            ?.querySelectorAll("section[data-turn-id]").length,
          active: document
            .querySelector("[data-cost-host]")
            ?.getAttribute("data-cost-active-session"),
        };
      });
      throw new Error(
        `流式更新未观察到目标轮重新渲染：${JSON.stringify(diagnostic)}；${(error as Error).message}`,
      );
    }
  },
  read: timelineRead,
  completion: "同一会话 3 次流式更新已应用到目标轮（wrapper render 计数前进）",
  requiredCapabilities: ["timeline.signals"],
};

const timelineInitialFill: RendererLayoutCostScenario = {
  id: "timeline-initial-fill",
  surface: "timeline",
  groups: ["timing", "counters"],
  mountIsOperation: true,
  waitDone: async (page) => {
    await page.waitForFunction(
      () => {
        const host = document.querySelector("[data-cost-host]");
        const timeline = document.querySelector('[data-testid="v4-timeline"]');
        if (host?.getAttribute("data-cost-ready") !== "1") return false;
        if (timeline?.querySelector("[data-v4-timeline-first-paint-staging]")) return false;
        if ((timeline?.querySelectorAll("section[data-turn-id]").length ?? 0) === 0) return false;
        const scoped = globalThis.__costTimeline as unknown as {
          signals?: () => TimelineSignals;
        };
        if (typeof scoped.signals !== "function") return true;
        const signals = scoped.signals();
        if (signals.firstPaintStaging === true) return false;
        if (signals.stagingPublishCount != null && signals.stagingPublishCount !== 1) return false;
        return true;
      },
      undefined,
      { timeout: 30_000, polling: "raf" },
    );
  },
  start: async () => undefined,
  read: timelineRead,
  completion: "首绘 staging 撤下、可见区只发布一次",
  requiredCapabilities: ["deferred-mount", "timeline.signals", "timeline.first-paint"],
};

const PREPEND_BEFORE = () => {
  const scoped = globalThis.__costTimeline as unknown as {
    signals?: () => TimelineSignals;
    read: () => TimelineSignals;
    fill: () => Record<string, number>;
  };
  const signals = scoped.signals ? scoped.signals() : scoped.read();
  const fill = scoped.fill();
  // 只记录成功提交次数；旧 fixture 的 commits 只是 attempt，不能当作前插成功。
  globalThis.__costPrependBefore = {
    minRowId: signals.minRowId ?? null,
    rowCount: signals.rowCount ?? null,
    pagesFetched: fill.pagesFetched ?? null,
    successfulPrependCommits: fill.successfulPrependCommits ?? null,
    olderFillPageCount: fill.olderFillPageCount ?? signals.fill?.olderFillPageCount ?? null,
    pendingOlder: signals.pendingOlder === true ? 1 : 0,
    inFlight: signals.inFlight ?? null,
  };
  return globalThis.__costPrependBefore;
};

const timelinePrependCommit: RendererLayoutCostScenario = {
  id: "timeline-prepend-commit",
  surface: "timeline",
  groups: ["timing", "counters"],
  warm: async (page) => {
    await waitForTimelineReady(page);
    await page.mouse.move(600, 450);
  },
  start: async (page) => {
    await page.evaluate(PREPEND_BEFORE);
    // 真实浏览器滚轮：8 次向上滚动触发预取、补齐与提交闸门，不使用脚本 scrollTop。
    for (let index = 0; index < 8; index += 1) {
      await page.mouse.wheel(0, -600);
      await nextPaint(page);
    }
  },
  waitDone: async (page) => {
    await page.waitForFunction(
      () => {
        const before = globalThis.__costPrependBefore;
        if (!before) return false;
        const scoped = globalThis.__costTimeline as unknown as {
          signals?: () => TimelineSignals;
          read: () => TimelineSignals;
          fill: () => Record<string, number>;
        };
        const signals = scoped.signals ? scoped.signals() : scoped.read();
        const fill = scoped.fill();
        // 缺成功计数时不能拿 attempt 顶上；直接结束，交由验收标记能力缺失。
        if (typeof fill.successfulPrependCommits !== "number") return true;
        if (!(fill.successfulPrependCommits > (before.successfulPrependCommits ?? 0))) return false;
        if (signals.pendingOlder === true) return false;
        if ((signals.inFlight ?? 0) > 0) return false;
        if (signals.minRowId != null && before.minRowId != null) {
          return signals.minRowId < before.minRowId;
        }
        return true;
      },
      undefined,
      { timeout: 30_000, polling: "raf" },
    );
  },
  read: timelineRead,
  completion: "真实滚轮后出现成功前插提交：minRowId 下降、无在途补页",
  requiredCapabilities: ["timeline.signals", "timeline.prepend", "timeline.inflight"],
};

/**
 * 真实完成态后才能观察滚动记忆：running 会话重挂载会吸底，把旧落点盖掉。
 * 先切 phase，再用真实滚轮把历史加载到 105 行，最后真实滚轮回到中部保存落点。
 */
async function prepareRestoreSession(page: Page): Promise<void> {
  await page.evaluate(() => globalThis.__costTimeline.setPhase("completedSuccess"));
  await page.waitForFunction(
    () => {
      const scoped = globalThis.__costTimeline as unknown as {
        fill?: () => { phase?: string };
      };
      return scoped.fill?.().phase === "completedSuccess";
    },
    undefined,
    { timeout: 10_000, polling: "raf" },
  );
  // 8 次向上真实滚轮：触发预取并提交剩余历史，直到 21 轮 / 105 行全部就位。
  for (let index = 0; index < 8; index += 1) {
    await page.mouse.wheel(0, -600);
    await nextPaint(page);
  }
  await page.waitForFunction(
    () => {
      const scoped = globalThis.__costTimeline as unknown as {
        signals?: () => TimelineSignals;
        fill: () => { successfulPrependCommits?: number; inFlight?: number; phase?: string };
      };
      const fill = scoped.fill();
      const signals = scoped.signals?.() ?? {};
      return (
        fill.phase === "completedSuccess" &&
        (fill.successfulPrependCommits ?? 0) > 0 &&
        (fill.inFlight ?? 0) === 0 &&
        signals.pendingOlder !== true &&
        signals.minRowId != null &&
        signals.minRowId <= 1 &&
        (signals.rowCount ?? 0) >= 105
      );
    },
    undefined,
    { timeout: 30_000, polling: "raf" },
  );
  // 真实滚轮回到中部；每步读一次缓存信号，避免用脚本 scrollTop。
  for (let index = 0; index < 20; index += 1) {
    const state = (await page.evaluate(() => {
      const scoped = globalThis.__costTimeline as unknown as {
        read: () => TimelineSignals;
      };
      const signals = scoped.read();
      return {
        scrollTop: signals.scrollTop ?? 0,
        clientHeight: signals.clientHeight ?? 0,
        scrollHeight: signals.scrollHeight ?? 0,
      };
    })) as { scrollTop: number; clientHeight: number; scrollHeight: number };
    const target = Math.max(0, Math.round((state.scrollHeight - state.clientHeight) * 0.5));
    if (Math.abs(state.scrollTop - target) <= 40) break;
    const delta = Math.max(-800, Math.min(800, target - state.scrollTop));
    await page.mouse.wheel(0, delta);
    await nextPaint(page);
  }
}

const timelineRestoreAwayBack: RendererLayoutCostScenario = {
  id: "timeline-restore-away-back",
  surface: "timeline",
  groups: ["timing", "counters"],
  warm: (page) => waitForTimelineReady(page),
  start: async (page) => {
    await prepareRestoreSession(page);
    await page.evaluate(() => {
      const scoped = globalThis.__costTimeline as unknown as {
        read: () => TimelineSignals;
      };
      const signals = scoped.read();
      globalThis.__costRestoreBefore = {
        scrollTop: Math.round(signals.scrollTop ?? 0),
        firstVisibleTurnId: signals.firstVisibleTurnId ?? null,
      };
      globalThis.__costTimeline.switchTo(0);
    });
    // 切走只等目标会话接管；切回后的恢复落点才是被测终点。
    await page.waitForFunction(
      () => {
        const host = document.querySelector("[data-cost-host]");
        return (
          host?.getAttribute("data-cost-active-index") === "0" &&
          host.getAttribute("data-cost-ready") === "1"
        );
      },
      undefined,
      { timeout: 20_000, polling: "raf" },
    );
    await page.evaluate(() => globalThis.__costTimeline.switchTo(1));
  },
  waitDone: async (page) => {
    await page.waitForFunction(
      () => {
        const host = document.querySelector("[data-cost-host]");
        if (host?.getAttribute("data-cost-active-index") !== "1") return false;
        return host.getAttribute("data-cost-ready") === "1";
      },
      undefined,
      { timeout: 30_000, polling: "raf" },
    );
    // 恢复落点由 fixture 的 restore 信号判定；不能要求整段补齐空闲，
    // 否则有界历史取尽后 staging 会一直保留，窗口无法结束。
    await waitForRestoreApplied(page);
  },
  read: timelineRead,
  completion: "真实完成态加载全部历史后，切走再切回恢复中部滚动记忆",
  requiredCapabilities: ["timeline.signals", "timeline.restore", "timeline.phase"],
};

export const TIMELINE_SCENARIOS: RendererLayoutCostScenario[] = [
  timelineSwitchTail,
  timelineScrollStream,
  timelineInitialFill,
  timelinePrependCommit,
  timelineRestoreAwayBack,
];

export const RENDERER_LAYOUT_COST_SCENARIOS: RendererLayoutCostScenario[] = [
  ...TIMELINE_SCENARIOS,
  ...UI_SCENARIOS,
];

export function scenarioById(id: string): RendererLayoutCostScenario | undefined {
  return RENDERER_LAYOUT_COST_SCENARIOS.find((item) => item.id === id);
}
