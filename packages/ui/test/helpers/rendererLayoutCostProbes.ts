/**
 * 测试页面内的两组探针。
 *
 * - `timing`：只装 PerformanceObserver 与标记数组，不 patch 任何 getter/setter，
 *   用于低开销时间对照。
 * - `counters`：patch Element/Node/EventTarget 与 MutationObserver，只用于几何读取、
 *   滚动来源和属性写入计数，产生的额外开销不得用于时间收益结论。
 *
 * 两组都在 bundle 求值之后、fixture mount 之前注入，因此 bundle 解析/编译产生的
 * longtask 不会进入测量窗口。缺失条目保持 null / supported=false，不能写成 0 成本。
 */

export type RendererLayoutCostProbeMode = "timing" | "counters";

const TIMING_PROBE = String.raw`
(() => {
  const marks = [];
  const events = [];
  const longTasks = [];
  const bootAt = performance.now();
  let eventSupported = false;
  let longTaskSupported = false;
  try {
    new PerformanceObserver(function (list) {
      for (const entry of list.getEntries()) {
        events.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          interactionId: entry.interactionId || 0,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
        });
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: false });
    eventSupported = true;
  } catch (error) {
    eventSupported = false;
  }
  try {
    new PerformanceObserver(function (list) {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: false });
    longTaskSupported = true;
  } catch (error) {
    longTaskSupported = false;
  }
  globalThis.__probe = {
    mode: "timing",
    bootAt: function () { return bootAt; },
    mark: function (name) {
      const t = performance.now();
      marks.push({ name: name, t: t });
      return t;
    },
    readMarks: function () { return marks.slice(); },
    readEvents: function () { return events.slice(); },
    readLongTasks: function () { return longTasks.slice(); },
    freeze: function () {},
    supported: function () { return { event: eventSupported, longTask: longTaskSupported }; },
    reset: function () {
      marks.length = 0;
      events.length = 0;
      longTasks.length = 0;
    },
  };
})();
`;

const COUNTER_PROBE = String.raw`
(() => {
  const counters = {
    gbcr: {},
    gets: {},
    sets: {},
    syntheticScroll: 0,
    nativeScroll: 0,
    userWheel: 0,
    userScroll: 0,
    scriptScroll: 0,
    toolbarProbeClones: 0,
    toolbarProbeAppends: 0,
    attributeWrites: {},
    sidepaneAddButtonRects: 0,
  };
  const marks = [];
  const bootAt = performance.now();
  let frozen = null;
  const rawGbr = Element.prototype.getBoundingClientRect;
  const rawLayout = {};
  const LAYOUT_PROPERTIES = ["scrollTop", "scrollLeft", "clientWidth", "clientHeight", "scrollWidth", "scrollHeight"];
  for (const property of LAYOUT_PROPERTIES) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, property);
    if (descriptor) rawLayout[property] = descriptor;
  }
  globalThis.__probeRawGbr = rawGbr;
  let lastScriptSetAt = -Infinity;

  function cloneCounters(source) {
    const clone = {};
    for (const key of Object.keys(source)) {
      const value = source[key];
      clone[key] = value && typeof value === "object" ? Object.assign({}, value) : value;
    }
    return clone;
  }
  function bump(map, key) { map[key] = (map[key] || 0) + 1; }
  function isToolbarProbe(node) {
    const element = node && node.nodeType === 1 ? node : node && node.parentElement;
    return Boolean(
      element && element.closest && element.closest('[data-cost-toolbar-root][aria-hidden="true"][inert]'),
    );
  }
  function surfaceOf(element) {
    if (!element || !element.closest) return "";
    const root = element.closest("[data-cost-root]");
    return root ? root.getAttribute("data-cost-root") || "" : "";
  }
  function wrapAccessor(property) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, property);
    if (!descriptor || !descriptor.get) return;
    Object.defineProperty(Element.prototype, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: function () {
        const surface = surfaceOf(this);
        if (surface) bump(counters.gets, surface + "." + property);
        return descriptor.get.call(this);
      },
      set: function (value) {
        const surface = surfaceOf(this);
        if (surface) bump(counters.sets, surface + "." + property);
        lastScriptSetAt = performance.now();
        if (descriptor.set) descriptor.set.call(this, value);
      },
    });
  }

  for (const property of LAYOUT_PROPERTIES) wrapAccessor(property);

  Element.prototype.getBoundingClientRect = function costGbr() {
    const surface = surfaceOf(this);
    if (surface) bump(counters.gbcr, surface);
    if (this.matches && this.matches("[data-side-pane-add-tab-trigger]")) counters.sidepaneAddButtonRects += 1;
    return rawGbr.call(this);
  };

  const rawCloneNode = Node.prototype.cloneNode;
  Node.prototype.cloneNode = function costCloneNode(deep) {
    if (this.nodeType === 1 && this.matches && this.matches("[data-cost-toolbar-root]")) {
      counters.toolbarProbeClones += 1;
    }
    return rawCloneNode.call(this, deep);
  };

  const rawDispatchEvent = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function costDispatchEvent(event) {
    if (event && event.type === "scroll" && !event.isTrusted) counters.syntheticScroll += 1;
    return rawDispatchEvent.call(this, event);
  };

  window.addEventListener("wheel", function (event) {
    if (event.isTrusted) counters.userWheel += 1;
  }, true);
  window.addEventListener("scroll", function (event) {
    if (!event.isTrusted) return;
    counters.nativeScroll += 1;
    // setter 触发的 scroll 与用户滚动都可能是 isTrusted；用最近一次脚本写入时间区分。
    if (performance.now() - lastScriptSetAt < 50) counters.scriptScroll += 1;
    else counters.userScroll += 1;
  }, true);

  try {
    new MutationObserver(function (records) {
      for (const record of records) {
        if (record.type === "attributes") {
          const target = record.target;
          if (!target || !target.closest) continue;
          // 隐藏探针自身的展开/回填写入属于测量工具，不是产品行为。
          if (isToolbarProbe(target)) continue;
          const toolbarRoot = target.closest("[data-cost-toolbar-root]");
          if (toolbarRoot) {
            const name = record.attributeName || "";
            if (name.indexOf("data-composer") === 0 || name === "style") bump(counters.attributeWrites, "toolbar");
            continue;
          }
          if (target.matches && target.matches("[data-side-pane-tabs-viewport]")) {
            const name = record.attributeName || "";
            if (name === "class" || name === "data-mask") bump(counters.attributeWrites, "sidepane");
          }
        } else if (record.type === "childList") {
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            // 探针是静默克隆后同步插入再移除的：回调时节点可能已脱离文档，
            // 不能靠 closest 判归属，改看克隆保留的工具栏根标记。
            if (
              node.matches &&
              node.matches("[data-cost-toolbar-root]") &&
              node.getAttribute("aria-hidden") === "true" &&
              node.hasAttribute("inert")
            ) {
              counters.toolbarProbeAppends += 1;
            }
          }
        }
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      childList: true,
      attributeFilter: [
        "class", "style", "data-mask", "data-composer-model-icon",
        "data-composer-provider-compact", "data-composer-compact",
      ],
    });
  } catch (error) {
    // MutationObserver 不可用时计数保持 0，report 层会标注 supported=false。
  }

  globalThis.__probe = {
    mode: "counters",
    bootAt: function () { return bootAt; },
    rawRect: function (element) { return rawGbr.call(element); },
    raw: {
      get: function (element, property) {
        const descriptor = rawLayout[property];
        return descriptor && descriptor.get ? descriptor.get.call(element) : element[property];
      },
      set: function (element, property, value) {
        // 夹具自身用 raw setter 避免计入 sets，但它仍是脚本写入；
        // 记下时间，随后 trusted scroll 会归入 scriptScroll 而不是 userScroll。
        lastScriptSetAt = performance.now();
        const descriptor = rawLayout[property];
        if (descriptor && descriptor.set) descriptor.set.call(element, value);
        else element[property] = value;
      },
    },
    mark: function (name) {
      const t = performance.now();
      marks.push({ name: name, t: t });
      return t;
    },
    readMarks: function () { return marks.slice(); },
    readEvents: function () { return []; },
    readLongTasks: function () { return []; },
    // 窗口结束立刻冻结，后续 nextPaint / 读取不会把空闲帧的属性写入或布局算进窗口。
    freeze: function () { frozen = cloneCounters(counters); },
    supported: function () {
      return { event: false, longTask: false, counters: typeof MutationObserver !== "undefined" };
    },
    reset: function () {
      for (const key of Object.keys(counters.gbcr)) delete counters.gbcr[key];
      for (const key of Object.keys(counters.gets)) delete counters.gets[key];
      for (const key of Object.keys(counters.sets)) delete counters.sets[key];
      for (const key of Object.keys(counters.attributeWrites)) delete counters.attributeWrites[key];
      counters.syntheticScroll = 0;
      counters.nativeScroll = 0;
      counters.userWheel = 0;
      counters.userScroll = 0;
      counters.scriptScroll = 0;
      counters.toolbarProbeClones = 0;
      counters.toolbarProbeAppends = 0;
      counters.sidepaneAddButtonRects = 0;
      lastScriptSetAt = -Infinity;
      frozen = null;
      marks.length = 0;
    },
    read: function () {
      return frozen ? cloneCounters(frozen) : cloneCounters(counters);
    },
  };
})();
`;

export function rendererLayoutCostProbeScript(mode: RendererLayoutCostProbeMode): string {
  return mode === "counters" ? COUNTER_PROBE : TIMING_PROBE;
}
