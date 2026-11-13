/**
 * 侧栏 fixture 页面源码。
 *
 * 驱动真实 overflow hook：current 用 `useSidePaneTabsOverflow`（几何缓存 + 只读 scrollLeft
 * 的热路径），prechange 用构建期从快照面板 AST 抽取的 bounded hook（每次 scroll 完整读几何）。
 * 两者共用同一 DOM 契约，因此 scroll 热路径的几何读取差异是可比的产品差异。
 *
 * 完成信号是 `geometryVersion`：宽度 / 标签数变化后等 overflow 与 mask 投影在连续帧上稳定，
 * 再前进版本号。`signals()` 不读几何；`read()` 才通过探针 raw getter 提供 scroll 指标。
 */
import { installProductCssImport } from "./rendererLayoutCostFixtureCss.js";

export const SIDEPANE_SOURCE = `${installProductCssImport()}
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useSidePaneTabsOverflow } from "@/app-shell/useSidePaneTabsOverflow.js";

const GEO = { version: 0, pending: 0, last: null, stable: 0, framesAfterOp: 0, running: false };
const LATEST = { width: 400, tabs: 8, overflow: false, mask: "00", scrollLeft: 0 };

function rawGet(element, property) {
  const probe = globalThis.__probe;
  return probe && probe.raw ? probe.raw.get(element, property) : element[property];
}
function rawSet(element, property, value) {
  const probe = globalThis.__probe;
  if (probe && probe.raw) probe.raw.set(element, property, value);
  else element[property] = value;
}

function viewportElement() {
  return document.querySelector("[data-side-pane-tabs-viewport]");
}

function geometrySignature() {
  const viewport = viewportElement();
  if (!viewport) return "";
  const addButton = viewport.parentElement
    ? viewport.parentElement.querySelector("[data-side-pane-add-tab-trigger]")
    : null;
  const content = document.querySelector("[data-side-pane-tabs-content]");
  return [
    viewport.getAttribute("data-mask"),
    addButton ? (content && content.contains(addButton) ? "inside" : "outside") : "none",
    LATEST.tabs,
  ].join("|");
}

// 一次操作 = overflow / mask / 新增按钮位置在连续帧上稳定；不沿用固定 settle。
function pumpGeometry() {
  GEO.running = true;
  const signature = geometrySignature();
  if (GEO.pending > 0) GEO.framesAfterOp += 1;
  if (signature === GEO.last) GEO.stable += 1;
  else { GEO.last = signature; GEO.stable = 0; }
  if (GEO.pending > 0 && GEO.framesAfterOp >= 2 && GEO.stable >= 2) {
    GEO.pending -= 1;
    GEO.framesAfterOp = 0;
    GEO.version += 1;
    if (GEO.pending > 0) requestAnimationFrame(pumpGeometry);
    else GEO.running = false;
    return;
  }
  if (GEO.pending > 0) requestAnimationFrame(pumpGeometry);
  else GEO.running = false;
}

function requestGeometrySettle() {
  GEO.pending += 1;
  if (!GEO.running) requestAnimationFrame(pumpGeometry);
}

function readSidePaneSignals() {
  return {
    width: LATEST.width,
    tabs: LATEST.tabs,
    overflow: LATEST.overflow,
    mask: LATEST.mask,
    scrollLeft: LATEST.scrollLeft,
    geometryVersion: GEO.version,
  };
}

function readSidePaneGeometry() {
  const viewport = viewportElement();
  if (!viewport) return readSidePaneSignals();
  return {
    ...readSidePaneSignals(),
    scrollLeft: rawGet(viewport, "scrollLeft"),
    scrollWidth: rawGet(viewport, "scrollWidth"),
    clientWidth: rawGet(viewport, "clientWidth"),
  };
}

function SidePaneFixture() {
  const [width, setWidth] = useState(400);
  const [count, setCount] = useState(8);
  const [titleVersion, setTitleVersion] = useState(0);
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const tabs = useMemo(function () {
    const result = [];
    for (let index = 0; index < count; index += 1) {
      result.push({ id: "tab-" + index, title: "Tab " + index + " v" + titleVersion });
    }
    return result;
  }, [count, titleVersion]);

  const overflow = useSidePaneTabsOverflow({ viewportRef: viewportRef, contentRef: contentRef, visibleTabs: tabs });
  const mask = (overflow.maskEdges.left ? "1" : "0") + (overflow.maskEdges.right ? "1" : "0");

  // 渲染期同步缓存：signals() 只返回这些值，不读 DOM 几何。
  LATEST.width = width;
  LATEST.tabs = count;
  LATEST.overflow = overflow.isOverflowing;
  LATEST.mask = mask;

  useEffect(function () {
    globalThis.__costSidePane = {
      setWidth: function (value) { requestGeometrySettle(); setWidth(value); },
      setCount: function (value) { requestGeometrySettle(); setCount(value); },
      bumpTitle: function () { setTitleVersion(function (value) { return value + 1; }); },
      scrollFraction: function (fraction) {
        const element = viewportRef.current;
        if (!element) return;
        const max = rawGet(element, "scrollWidth") - rawGet(element, "clientWidth");
        rawSet(element, "scrollLeft", Math.round(max * fraction));
      },
      read: readSidePaneGeometry,
      signals: readSidePaneSignals,
    };
    if (!window.__costSidePaneMounted) {
      window.__costSidePaneMounted = true;
      requestGeometrySettle();
    }
  });

  useEffect(function () {
    const element = viewportRef.current;
    if (!element) return;
    const onScroll = function () { LATEST.scrollLeft = rawGet(element, "scrollLeft"); };
    element.addEventListener("scroll", onScroll, { passive: true });
    return function () { element.removeEventListener("scroll", onScroll); };
  }, []);

  const addButton = (
    <button data-side-pane-add-tab-trigger style={{ width: 40, height: 40, flexShrink: 0 }}>+</button>
  );

  return (
    <div
      data-cost-root="sidepane"
      data-cost-ready="1"
      data-overflow={overflow.isOverflowing ? "1" : "0"}
      style={{ width: width + "px", padding: 8 }}
    >
      <div style={{ display: "flex", alignItems: "center", width: "100%" }}>
        <div
          ref={viewportRef}
          data-side-pane-tabs-viewport
          data-mask={mask}
          style={{ display: "flex", overflowX: "auto", width: "100%", height: 48 }}
        >
          <div ref={contentRef} data-side-pane-tabs-content style={{ display: "flex", gap: 4, minWidth: "100%" }}>
            {tabs.map(function (tab) {
              return (
                <button
                  key={tab.id}
                  data-side-pane-tab-id={tab.id}
                  style={{ minWidth: 60, flex: "1 1 0", height: 40, overflow: "hidden" }}
                >
                  {tab.title}
                </button>
              );
            })}
            {!overflow.isOverflowing ? addButton : null}
          </div>
        </div>
        {overflow.isOverflowing ? addButton : null}
      </div>
    </div>
  );
}

function mountSidePane() {
  createRoot(document.getElementById("root")).render(<SidePaneFixture />);
}

globalThis.__costSidePane = {
  mount: mountSidePane,
  setWidth: function () {},
  setCount: function () {},
  bumpTitle: function () {},
  scrollFraction: function () {},
  read: readSidePaneGeometry,
  signals: readSidePaneSignals,
};

globalThis.__costFixture = {
  version: 2,
  deferredMount: true,
  capabilities: ["deferred-mount", "sidepane.signals", "sidepane.geometry-version"],
  surfaces: ["sidepane"],
};
`;
