/**
 * 三种 fixture 页面源码的协调入口。
 *
 * - timeline：真实 `ConversationTimeline` + 真实 `ConversationProjectionStore`；
 * - toolbar：真实 `useComposerToolbarFit` + 有界 DOM；
 * - sidepane：真实 overflow hook（prechange 由快照面板 AST 抽取）。
 *
 * 三种页面都要求「启动前已有完整产品 CSS」：入口顶部注入 Build 静态生成的产品样式，
 * 早于 React mount 与首绘 staging。页面源码按表面拆到独立文件，契约与完成信号各自维护。
 */
import type { RendererLayoutCostSurface } from "./rendererLayoutCostTypes.js";
import { LAYOUT_COST_PAGE_SKELETON } from "./rendererLayoutCostFixtureCss.js";
import { SIDEPANE_SOURCE } from "./rendererLayoutCostFixtureSidePane.js";
import { TIMELINE_SOURCE } from "./rendererLayoutCostFixtureTimeline.js";
import { TOOLBAR_SOURCE } from "./rendererLayoutCostFixtureToolbar.js";

export { LAYOUT_COST_PAGE_SKELETON };

export function createFixtureSource(surface: RendererLayoutCostSurface): string {
  if (surface === "timeline") return TIMELINE_SOURCE;
  if (surface === "toolbar") return TOOLBAR_SOURCE;
  return SIDEPANE_SOURCE;
}
