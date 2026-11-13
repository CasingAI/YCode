/**
 * 页面内 fixture 能力、低开销完成信号与就绪等待。
 *
 * 正式时间对照只允许用 `signals()` / DOM 属性做完成判定；`read()` 会读取几何，
 * 仅作为缺少新 API 时的冒烟回退。因此每次采样都会记录 `timingEligible`。
 */
import type { Page } from "playwright-core";

import type {
  RendererLayoutCostSignals,
  RendererLayoutCostSurface,
  TimelineSignals,
  ToolbarSignals,
  SidePaneSignals,
  TurnCounts,
} from "./rendererLayoutCostTypes.js";

export interface FixtureCapabilities {
  version: number | null;
  deferredMount: boolean;
  capabilities: string[];
  surfaces: RendererLayoutCostSurface[];
}

const CAPABILITY_NAMES = [
  "deferred-mount",
  "timeline.signals",
  "timeline.first-paint",
  "timeline.prepend",
  "timeline.restore",
  "timeline.inflight",
  "toolbar.signals",
  "toolbar.fit-version",
  "sidepane.signals",
  "sidepane.geometry-version",
] as const;

export function requiredCapabilityNames(): readonly string[] {
  return CAPABILITY_NAMES;
}

function scopedName(surface: RendererLayoutCostSurface): string {
  return surface === "timeline"
    ? "__costTimeline"
    : surface === "toolbar"
      ? "__costToolbar"
      : "__costSidePane";
}

export async function readFixtureCapabilities(page: Page): Promise<FixtureCapabilities> {
  return page.evaluate(() => {
    const value = (globalThis as { __costFixture?: Record<string, unknown> }).__costFixture;
    return value
      ? {
          version: typeof value.version === "number" ? value.version : null,
          deferredMount: value.deferredMount === true,
          capabilities: Array.isArray(value.capabilities)
            ? (value.capabilities as unknown[]).filter(
                (item): item is string => typeof item === "string",
              )
            : [],
          surfaces: Array.isArray(value.surfaces)
            ? (value.surfaces as RendererLayoutCostSurface[])
            : [],
        }
      : { version: null, deferredMount: false, capabilities: [], surfaces: [] };
  });
}

/** 只有 fixture 明确暴露 mount 时才延迟挂载；旧 fixture 在 bundle 求值时已自动挂载。 */
export async function mountSurface(
  page: Page,
  surface: RendererLayoutCostSurface,
): Promise<boolean> {
  return page.evaluate((name) => {
    const scoped = (globalThis as Record<string, { mount?: () => void }>)[name];
    if (!scoped || typeof scoped.mount !== "function") return false;
    scoped.mount();
    return true;
  }, scopedName(surface));
}

export async function readSurfaceState(
  page: Page,
  surface: RendererLayoutCostSurface,
): Promise<Record<string, unknown>> {
  return page.evaluate((name) => {
    const scoped = (globalThis as Record<string, Record<string, unknown>>)[name];
    if (!scoped) return {};
    const base =
      typeof scoped.signals === "function"
        ? (scoped.signals as () => Record<string, unknown>)()
        : typeof scoped.read === "function"
          ? (scoped.read as () => Record<string, unknown>)()
          : {};
    const out: Record<string, unknown> = { ...base };
    if (typeof scoped.fill === "function") {
      out.fill = {
        ...(out.fill as Record<string, unknown>),
        ...(scoped.fill as () => Record<string, unknown>)(),
      };
    }
    if (typeof scoped.turnCounts === "function") {
      out.turnCounts = (scoped.turnCounts as () => TurnCounts)();
    }
    const globals = globalThis as Record<string, unknown>;
    if (globals.__costBeforeTurnCounts) out.beforeTurnCounts = globals.__costBeforeTurnCounts;
    if (globals.__costPrependBefore) out.prependBefore = globals.__costPrependBefore;
    if (globals.__costRestoreBefore) out.restoreBefore = globals.__costRestoreBefore;
    return out;
  }, scopedName(surface));
}

/** 轻量等待信号：优先 fixture 的 `signals()`，避免在窗口内读几何。 */
async function readWaitSignals(
  page: Page,
  surface: RendererLayoutCostSurface,
): Promise<{ value: Record<string, unknown>; lightweight: boolean }> {
  return page.evaluate((name) => {
    const scoped = (globalThis as Record<string, Record<string, unknown>>)[name];
    if (!scoped) return { value: {}, lightweight: false };
    if (typeof scoped.signals === "function") {
      return {
        value: (scoped.signals as () => Record<string, unknown>)(),
        lightweight: true,
      };
    }
    if (typeof scoped.read === "function") {
      return { value: (scoped.read as () => Record<string, unknown>)(), lightweight: false };
    }
    return { value: {}, lightweight: false };
  }, scopedName(surface));
}

export async function surfaceUsesLightweightSignals(
  page: Page,
  surface: RendererLayoutCostSurface,
): Promise<boolean> {
  return (await readWaitSignals(page, surface)).lightweight;
}

export async function readWaitState(
  page: Page,
  surface: RendererLayoutCostSurface,
): Promise<RendererLayoutCostSignals> {
  return (await readWaitSignals(page, surface)).value as RendererLayoutCostSignals;
}

export async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

export async function waitForDom(page: Page, predicate: string, timeoutMs = 15_000): Promise<void> {
  await page.waitForFunction(predicate, undefined, { timeout: timeoutMs, polling: "raf" });
}

export async function waitForTimelineReady(page: Page, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const host = document.querySelector("[data-cost-host]");
      const timeline = document.querySelector('[data-testid="v4-timeline"]');
      if (!host || !timeline) return false;
      if (host.getAttribute("data-cost-ready") !== "1") return false;
      if (timeline.querySelector("[data-v4-timeline-first-paint-staging]")) return false;
      return timeline.querySelectorAll("section[data-turn-id]").length > 0;
    },
    undefined,
    { timeout: timeoutMs, polling: "raf" },
  );
}

export async function waitForSurfaceReady(
  page: Page,
  surface: RendererLayoutCostSurface,
  timeoutMs = 20_000,
): Promise<void> {
  if (surface === "timeline") {
    await waitForTimelineReady(page, timeoutMs);
    return;
  }
  await page.waitForFunction(
    (name) =>
      Boolean(document.querySelector('[data-cost-ready="1"][data-cost-root="' + name + '"]')),
    surface,
    { timeout: timeoutMs, polling: "raf" },
  );
}

/** 等 fixture 的版本字段前进；缺字段时返回 false，由调用方退回一帧并标记时间不可用。 */
export async function waitVersionAdvance(
  page: Page,
  surface: RendererLayoutCostSurface,
  field: "fitVersion" | "geometryVersion",
  previous: number | null,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (previous === null) return false;
  try {
    await page.waitForFunction(
      (payload) => {
        const scoped = (globalThis as Record<string, { signals?: () => Record<string, unknown> }>)[
          payload.name
        ];
        if (!scoped || typeof scoped.signals !== "function") return false;
        const value = scoped.signals()[payload.field];
        return typeof value === "number" && value > payload.previous;
      },
      { name: scopedName(surface), field, previous },
      { timeout: timeoutMs, polling: "raf" },
    );
    return true;
  } catch {
    return false;
  }
}

export function timelineSignals(value: RendererLayoutCostSignals): TimelineSignals {
  return value as TimelineSignals;
}

export function toolbarSignals(value: RendererLayoutCostSignals): ToolbarSignals {
  return value as ToolbarSignals;
}

export function sidePaneSignals(value: RendererLayoutCostSignals): SidePaneSignals {
  return value as SidePaneSignals;
}
