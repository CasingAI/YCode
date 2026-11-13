/** 独立 Chromium 页面骨架、等待与性能指标读取。 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright-core";

import { uiRoot } from "./chromiumFixture.js";
import type { DerivedStatsSample } from "./conversationUpdateCostTypes.js";

interface CostScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  firstVisibleTurnId: string | null;
}

interface CostViewState {
  activeSessionId: string | null;
  view: string | null;
  tasksClass: string | null;
  filesClass: string | null;
  filesChrome: Array<{
    name: string | null;
    leadingInset: string;
    trailingInset: string;
    topInset: string;
    height: string;
    rect: { left: number; top: number; right: number; bottom: number };
  }>;
}

interface CostPageApi {
  ready(): boolean;
  startUpdates(intervalMs: number): void;
  stopUpdates(): void;
  pushUpdates(sessionIndex: number, count: number): void;
  pushActiveUpdates(count: number): void;
  resetStats(): void;
  readStats(): {
    gbcr: number;
    anyInnerHtml: number;
    styleInnerHtml: number;
    timelineScrollTopGets: number;
    timelineScrollTopSets: number;
    timelineScrollTopGetStacks?: string[];
  };
  resetDerivedStats(): void;
  readDerivedStats(): DerivedStatsSample;
  swapGuideItem(): boolean;
  toggleMembership(): boolean;
  resetTurnCounts(): void;
  readTurnCounts(): Record<string, { count: number; isRunning: boolean }>;
  resetTimelineRenders(): void;
  readTimelineRenders(): number;
  installScrollProbe(): void;
  startScrollTrace(): boolean;
  stopScrollTrace(): Array<{
    t: number;
    source: string;
    top: number;
    scrollHeight: number;
    clientHeight: number;
    activeSession: string | null;
  }>;
  readScrollMemory(): Record<string, unknown>;
  markScrollTrace(name: string): void;
  scrollTo(top: number): void;
  scrollToTop(): void;
  readScrollState(): CostScrollState | null;
  readViewState(): CostViewState;
  readRadix(): { contentOpen: boolean; styleCount: number; styleTextLengths: number[] };
  readEvents(): Array<Record<string, number | string>>;
  readLongTasks(): Array<{ startTime: number; duration: number }>;
  mark(name: string): void;
  readMarks(): Array<{ name: string; t: number }>;
  clearMarks(): void;
  /** reactCommitMs 是 flushSync 包围 render+DOM+layout 的同步更新耗时。 */
  getSyncEntries(): Array<{ step: string; reactCommitMs: number }>;
  clearSyncEntries(): void;
  clickTestId(testId: string): boolean;
  clickFirstHistoryTrigger(): string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __cost: CostPageApi;
  // eslint-disable-next-line no-var
  var __costRerenderRadix: ((count: number) => void) | undefined;
  // eslint-disable-next-line no-var
  var __costEvents: Array<Record<string, number | string>>;
  // eslint-disable-next-line no-var
  var __costLongTasks: Array<{ startTime: number; duration: number }>;
  // eslint-disable-next-line no-var
  var __costMarks: Array<{ name: string; t: number }>;
  // eslint-disable-next-line no-var
  var __costSync: Array<{ step: string; reactCommitMs: number }>;
  // eslint-disable-next-line no-var
  var __costTurnCounts: Map<string, { count: number; isRunning: boolean }> | undefined;
  // eslint-disable-next-line no-var
  var __costTimelineRenders: number | undefined;
}

const PERF_KEYS = [
  "LayoutCount",
  "RecalcStyleCount",
  "LayoutDuration",
  "RecalcStyleDuration",
  "TaskDuration",
  "ScriptDuration",
] as const;

export const PAGE_SKELETON = `<!doctype html><html><head><script>globalThis.__name = value => value;</script>
<style>
html,body,#root{height:100%;margin:0;padding:0}
body{font:14px/20px system-ui,sans-serif;background:#fff;color:#111}
[data-cost-host]{height:100%}
[data-testid="v4-timeline"]{flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden}
section[data-turn-id]{min-height:40px}
button{font:inherit;padding:2px 6px}
</style>
</head><body><div id="root"></div></body></html>`;

export async function settle(page: Page, delayMs = 40): Promise<void> {
  await page.evaluate(
    (delay) =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(resolve, delay);
          });
        });
      }),
    delayMs,
  );
}

export async function readPerf(session: CDPSession): Promise<Record<string, number>> {
  const result = (await session.send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  const metrics: Record<string, number> = {};
  for (const metric of result.metrics) metrics[metric.name] = metric.value;
  return metrics;
}

export function perfDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const key of PERF_KEYS) delta[key] = (after[key] ?? 0) - (before[key] ?? 0);
  return delta;
}

export async function waitForReady(page: Page, errors: string[]): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const host = document.querySelector("[data-cost-host]");
        const timeline = document.querySelector('[data-testid="v4-timeline"]');
        return Boolean(host && host.getAttribute("data-cost-ready") === "1" && timeline);
      },
      undefined,
      { timeout: 20_000 },
    );
  } catch (error) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => "");
    throw new Error(
      `fixture 未就绪: ${(error as Error).message}
page errors: ${errors.join(" | ")}
body: ${body}`,
    );
  }
  await page.waitForFunction(
    () => {
      const timeline = document.querySelector('[data-testid="v4-timeline"]');
      return Boolean(timeline && timeline.querySelector("section[data-turn-id]"));
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => {
      const timeline = document.querySelector('[data-testid="v4-timeline"]');
      return Boolean(timeline && timeline.scrollHeight > timeline.clientHeight + 100);
    },
    undefined,
    { timeout: 20_000 },
  );
  const body = await page.evaluate(() => document.body.innerText.slice(0, 300));
  if (errors.length > 0) throw new Error(`页面错误: ${errors.join(" | ")}\nbody: ${body}`);
}

export async function collectTailwindCss(page: Page): Promise<string> {
  const { compile } = await import("@tailwindcss/node");
  const classes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("[class]")].flatMap((element) => [...element.classList]),
    ),
  ]);
  const sourceCss = await readFile(join(uiRoot, "src/styles.css"), "utf8");
  const compiler = await compile(sourceCss, {
    base: join(uiRoot, "src"),
    onDependency: () => undefined,
  });
  return compiler.build(classes);
}

export async function openRadixSelect(page: Page): Promise<void> {
  await page.locator("[data-cost-radix-trigger]").click();
  await page.waitForSelector('[data-slot="select-content"]', { state: "attached", timeout: 5_000 });
}

export async function closeRadixSelect(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector('[data-slot="select-content"]'),
    undefined,
    {
      timeout: 5_000,
    },
  );
}
