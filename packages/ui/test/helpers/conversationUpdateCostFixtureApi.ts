/** fixture 页面源码第 2 段：有界探针与页面 API。 */
export const conversationUpdateCostFixtureApiSource = String.raw`
// ---------------------------------------------------------------------------
// 页面 API
// ---------------------------------------------------------------------------
function rawRect(element) {
  return globalThis.__costRawGBR.call(element);
}
function timelineElement() {
  return document.querySelector('[data-testid="v4-timeline"]');
}
function findScrollTopDescriptor(element) {
  let proto = Object.getPrototypeOf(element);
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "scrollTop");
    if (descriptor) return descriptor;
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}
function rawScrollTop(element) {
  const descriptor = findScrollTopDescriptor(element);
  if (!descriptor) return 0;
  return descriptor.get.call(element);
}
function firstVisibleTurnId() {
  const container = timelineElement();
  if (!container) return null;
  const containerRect = rawRect(container);
  let best = null;
  for (const section of container.querySelectorAll("section[data-turn-id]")) {
    const rect = rawRect(section);
    if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;
    if (!best || rect.top < best.top) {
      best = { top: rect.top, turnId: section.getAttribute("data-turn-id") };
    }
  }
  return best ? best.turnId : null;
}

function readScrollState() {
  const container = timelineElement();
  if (!container) return null;
  return {
    scrollTop: rawScrollTop(container),
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    firstVisibleTurnId: firstVisibleTurnId(),
  };
}

function installTimelineScrollProbe() {
  const element = timelineElement();
  if (!element || element.__costScrollProbe) return;
  const descriptor = findScrollTopDescriptor(element);
  if (!descriptor) return;
  globalThis.__costRawScrollDescriptor = descriptor;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get() {
      // 低开销对照只计数，不采样调用栈：栈采集本身会放大热路径成本。
      STATS.timelineScrollTopGets += 1;
      return descriptor.get.call(element);
    },
    set(value) {
      STATS.timelineScrollTopSets += 1;
      descriptor.set.call(element, value);
    },
  });
  element.__costScrollProbe = true;
}

// 恢复证据只用离散 mark + scroll 事件，不挂 rAF 逐帧轨迹。
// 逐帧采样会改变同一页面的调度与耗时，不能与低开销样本混用。
const SCROLL_TRACE_LIMIT = 400;
function startScrollTrace() {
  const element = timelineElement();
  if (!element) return false;
  if (element.__costScrollTraceCleanup) element.__costScrollTraceCleanup();
  const entries = [];
  globalThis.__costScrollTrace = entries;
  const record = (source) => {
    if (entries.length >= SCROLL_TRACE_LIMIT) return;
    entries.push({
      t: Math.round(performance.now() * 10) / 10,
      source,
      top: Math.round(rawScrollTop(element) * 10) / 10,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      turn: firstVisibleTurnId(),
      activeSession: document
        .querySelector("[data-cost-host]")
        ?.getAttribute("data-cost-active-session"),
    });
  };
  const onScroll = () => record("scroll");
  element.addEventListener("scroll", onScroll, { passive: true });
  const cleanup = () => {
    element.removeEventListener("scroll", onScroll);
  };
  element.__costScrollTraceCleanup = cleanup;
  globalThis.__costScrollTraceRecord = record;
  record("start");
  return true;
}
function stopScrollTrace() {
  const element = timelineElement();
  if (element && element.__costScrollTraceCleanup) {
    element.__costScrollTraceCleanup();
    delete element.__costScrollTraceCleanup;
  }
  delete globalThis.__costScrollTraceRecord;
  return globalThis.__costScrollTrace ? [...globalThis.__costScrollTrace] : [];
}
function readScrollMemory() {
  const result = {};
  for (const id of SESSION_IDS) {
    result[id] = readChatSessionScrollMemoryState("cost-memory/" + id);
  }
  return result;
}

function readFilesChrome() {
  const rows = [...document.querySelectorAll("[data-cost-tablist]")];
  return rows.map((row) => ({
    name: row.getAttribute("data-cost-tablist"),
    leadingInset: row.style.getPropertyValue("--files-tabbar-leading-inset"),
    trailingInset: row.style.getPropertyValue("--files-tabbar-trailing-inset"),
    topInset: row.style.getPropertyValue("--files-tabbar-top-inset"),
    height: row.style.getPropertyValue("--files-tabbar-height"),
    rect: (() => {
      const rect = rawRect(row);
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    })(),
  }));
}

function readViewState() {
  const host = document.querySelector("[data-cost-host]");
  const tasks = document.querySelector('[data-cost-layer="tasks"]');
  const files = document.querySelector('[data-cost-layer="files"]');
  return {
    activeSessionId: host ? host.getAttribute("data-cost-active-session") : null,
    view: host ? host.getAttribute("data-cost-view") : null,
    tasksClass: tasks ? tasks.className : null,
    filesClass: files ? files.className : null,
    filesChrome: readFilesChrome(),
  };
}

function readTurnCounts() {
  const map = globalThis.__costTurnCounts;
  if (!map) return {};
  const result = {};
  for (const [turnId, entry] of map) result[turnId] = { count: entry.count, isRunning: entry.isRunning };
  return result;
}

function readRadix() {
  const content = document.querySelector('[data-slot="select-content"]');
  const styles = [...document.querySelectorAll("style")];
  return {
    contentOpen: Boolean(content),
    styleCount: styles.length,
    styleTextLengths: styles.map((style) => style.textContent ? style.textContent.length : 0),
  };
}

globalThis.__cost = {
  ready: () => Boolean(document.querySelector('[data-cost-ready="1"]')),
  startUpdates,
  stopUpdates,
  pushUpdates,
  pushActiveUpdates: (count) => pushUpdates(Number(document.querySelector("[data-cost-host]").getAttribute("data-cost-active-index")), count),
  resetStats: () => {
    STATS.gbcr = 0;
    STATS.anyInnerHtml = 0;
    STATS.styleInnerHtml = 0;
    STATS.timelineScrollTopGets = 0;
    STATS.timelineScrollTopSets = 0;
    STATS.timelineScrollTopGetStacks = [];
  },
  readStats: () => ({ ...STATS }),
  resetDerivedStats: () => {
    if (globalThis.__costResetDerivedStats) globalThis.__costResetDerivedStats();
  },
  readDerivedStats: () => ({ ...(globalThis.__costDerivedStats || {}) }),
  swapGuideItem: () => {
    if (!globalThis.__costSwapGuideItem) return false;
    globalThis.__costSwapGuideItem();
    return true;
  },
  toggleMembership: () => {
    if (!globalThis.__costToggleMember) return false;
    globalThis.__costToggleMember();
    return true;
  },
  resetTurnCounts: () => {
    globalThis.__costTurnCounts = new Map();
  },
  readTurnCounts,
  resetTimelineRenders: () => {
    globalThis.__costTimelineRenders = 0;
  },
  readTimelineRenders: () => globalThis.__costTimelineRenders || 0,
  installScrollProbe: installTimelineScrollProbe,
  startScrollTrace,
  stopScrollTrace,
  readScrollMemory,
  markScrollTrace: (name) => {
    if (globalThis.__costScrollTraceRecord) globalThis.__costScrollTraceRecord(name);
  },
  scrollTo: (top) => {
    const element = timelineElement();
    if (element) element.scrollTop = top;
  },
  scrollToTop: () => {
    const element = timelineElement();
    if (element) element.scrollTop = 0;
  },
  readScrollState,
  readViewState,
  readRadix,
  readEvents: () => [...globalThis.__costEvents],
  readLongTasks: () => [...globalThis.__costLongTasks],
  mark: (name) => {
    globalThis.__costMarks.push({ name, t: performance.now() });
  },
  readMarks: () => [...globalThis.__costMarks],
  clearMarks: () => {
    globalThis.__costMarks.length = 0;
  },
  getSyncEntries: () => [...(globalThis.__costSync || [])],
  clearSyncEntries: () => {
    globalThis.__costSync.length = 0;
  },
  clickTestId: (testId) => {
    const element = document.querySelector('[data-testid="' + testId + '"]');
    if (!element) return false;
    element.click();
    return true;
  },
  clickFirstHistoryTrigger: () => {
    const container = timelineElement();
    if (!container) return null;
    const trigger = container.querySelector('[data-testid^="chat-assistant-history-trigger-"]');
    if (!trigger) return null;
    const before = trigger.getAttribute("aria-expanded");
    trigger.click();
    return before;
  },
};

globalThis.__costSync = [];
globalThis.__costTurnCounts = new Map();

`;
