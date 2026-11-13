/** 工具栏与侧栏场景：完成信号优先用 fixture 的 fit/geometry 版本。 */
import type { Page } from "playwright-core";

import {
  nextPaint,
  readSurfaceState,
  readWaitState,
  waitForSurfaceReady,
  waitVersionAdvance,
} from "./rendererLayoutCostPageSignals.js";
import type { RendererLayoutCostScenario } from "./rendererLayoutCostScenarios.js";

type Surface = "toolbar" | "sidepane";

function scopedName(surface: Surface): string {
  return surface === "toolbar" ? "__costToolbar" : "__costSidePane";
}

async function call(page: Page, surface: Surface, method: string, arg?: unknown): Promise<void> {
  await page.evaluate(
    (payload) => {
      const scoped = (globalThis as Record<string, Record<string, (value?: unknown) => void>>)[
        payload.name
      ];
      scoped?.[payload.method]?.(payload.arg);
    },
    { name: scopedName(surface), method, arg },
  );
}

async function stepWithVersion(
  page: Page,
  surface: Surface,
  method: string,
  arg: unknown,
  versionField: "fitVersion" | "geometryVersion",
): Promise<void> {
  const before = await readWaitState(page, surface);
  const previous =
    typeof (before as Record<string, unknown>)[versionField] === "number"
      ? ((before as Record<string, unknown>)[versionField] as number)
      : null;
  await call(page, surface, method, arg);
  if (previous !== null) {
    const advanced = await waitVersionAdvance(page, surface, versionField, previous);
    if (advanced) return;
  }
  // 旧 fixture 没有版本字段：退回一帧作为“操作已提交”的近似，本样本会标记时间不可用。
  await nextPaint(page);
}

const toolbarWidthSweep: RendererLayoutCostScenario = {
  id: "toolbar-width-sweep",
  surface: "toolbar",
  groups: ["timing", "counters"],
  warm: (page) => waitForSurfaceReady(page, "toolbar"),
  start: async (page) => {
    const widths = [1200, 900, 700, 520, 360, 520, 700, 900, 1200];
    for (const width of widths) {
      await stepWithVersion(page, "toolbar", "setWidth", width, "fitVersion");
    }
  },
  // 每步已等到 fitVersion 前进；不再追加固定帧作为 settle。
  waitDone: async () => undefined,
  read: (page) => readSurfaceState(page, "toolbar"),
  completion: "宽度往返 9 步全部应用（fit 版本前进）",
  requiredCapabilities: ["toolbar.signals", "toolbar.fit-version"],
};

const toolbarStableRepeat: RendererLayoutCostScenario = {
  id: "toolbar-stable-repeat",
  surface: "toolbar",
  groups: ["timing", "counters"],
  warm: async (page) => {
    await waitForSurfaceReady(page, "toolbar");
    await stepWithVersion(page, "toolbar", "setWidth", 520, "fitVersion");
  },
  start: async (page) => {
    for (let index = 0; index < 5; index += 1) {
      await stepWithVersion(page, "toolbar", "nudge", undefined, "fitVersion");
    }
  },
  waitDone: async () => undefined,
  read: (page) => readSurfaceState(page, "toolbar"),
  completion: "稳定宽度下 5 次纯文本变化完成测量（不重绑观察集合）",
  requiredCapabilities: ["toolbar.signals", "toolbar.fit-version"],
};

const sidePaneScrollHotpath: RendererLayoutCostScenario = {
  id: "sidepane-scroll-hotpath",
  surface: "sidepane",
  groups: ["timing", "counters"],
  warm: async (page) => {
    await waitForSurfaceReady(page, "sidepane");
    await stepWithVersion(page, "sidepane", "setWidth", 360, "geometryVersion");
  },
  start: async (page) => {
    const fractions = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0, 1];
    for (const fraction of fractions) {
      await call(page, "sidepane", "scrollFraction", fraction);
      await nextPaint(page);
    }
  },
  // start 内每次 scroll 后都等了一帧；最后一次操作的可观察完成即窗口终点。
  waitDone: async () => undefined,
  read: (page) => readSurfaceState(page, "sidepane"),
  completion: "10 次普通 scroll 位置更新完成；稳定几何下只读 scrollLeft",
  requiredCapabilities: ["sidepane.signals", "sidepane.geometry-version"],
};

const sidePaneOverflowChange: RendererLayoutCostScenario = {
  id: "sidepane-overflow-change",
  surface: "sidepane",
  groups: ["timing", "counters"],
  warm: (page) => waitForSurfaceReady(page, "sidepane"),
  start: async (page) => {
    const widths = [700, 500, 420, 360, 300, 420, 600, 800];
    for (const width of widths) {
      await stepWithVersion(page, "sidepane", "setWidth", width, "geometryVersion");
    }
    await stepWithVersion(page, "sidepane", "setCount", 4, "geometryVersion");
    await stepWithVersion(page, "sidepane", "setCount", 10, "geometryVersion");
  },
  waitDone: async () => undefined,
  read: (page) => readSurfaceState(page, "sidepane"),
  completion: "宽度与标签成员变化后 overflow/新增按钮换位完成",
  requiredCapabilities: ["sidepane.signals", "sidepane.geometry-version"],
};

export const UI_SCENARIOS: RendererLayoutCostScenario[] = [
  toolbarWidthSweep,
  toolbarStableRepeat,
  sidePaneScrollHotpath,
  sidePaneOverflowChange,
];
