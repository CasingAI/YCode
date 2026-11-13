/** fixture 页面源码第 1 段：观察器、会话模型与受控 transport。 */
export const conversationUpdateCostFixtureModelSource = String.raw`
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
// __COST_DERIVED_IMPORTS__
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { readChatSessionScrollMemoryState } from "@/lib/chatSessionScrollMemory.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useFilesWorkbenchTabChrome } from "@/files-workbench/useFilesWorkbenchTabChrome.js";
import {
  resolveWorkspaceShellFilesSurfaceClassName,
  resolveWorkspaceShellTasksKeepaliveClassName,
} from "@/app-shell/workspaceShellResponsiveLayout.js";

// ---------------------------------------------------------------------------
// 计数与观察器：在 React 挂载之前安装，只统计本 fixture 页面。
// ---------------------------------------------------------------------------
const STATS = {
  gbcr: 0,
  anyInnerHtml: 0,
  styleInnerHtml: 0,
  timelineScrollTopGets: 0,
  timelineScrollTopSets: 0,
  timelineScrollTopGetStacks: [],
};
globalThis.__costStats = STATS;
globalThis.__costEvents = [];
globalThis.__costLongTasks = [];
globalThis.__costMarks = [];

(function installObservers() {
  const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  if (innerHtml && innerHtml.get && innerHtml.set) {
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      get: innerHtml.get,
      set(value) {
        STATS.anyInnerHtml += 1;
        if (this.tagName === "STYLE") STATS.styleInnerHtml += 1;
        innerHtml.set.call(this, value);
      },
    });
  }
  const rawGbr = Element.prototype.getBoundingClientRect;
  globalThis.__costRawGBR = rawGbr;
  Element.prototype.getBoundingClientRect = function costGbr() {
    STATS.gbcr += 1;
    return rawGbr.call(this);
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        globalThis.__costEvents.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          interactionId: entry.interactionId || 0,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
        });
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        globalThis.__costLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {}
})();

// ---------------------------------------------------------------------------
// 会话模型：4 个已知会话，各 26 组完成轮 + 末轮运行态。
// ---------------------------------------------------------------------------
const SESSION_IDS = ["sess-cost-a", "sess-cost-b", "sess-cost-c", "sess-cost-d"];
const EMPTY_ROWS = [];
const UPDATE_INTERVAL_MS = 40;
const TURN_COUNT = 26;
const INITIAL_SEQ = 1000;

function buildRows(sessionIndex) {
  const rows = [];
  let rowId = 0;
  for (let turnIndex = 0; turnIndex < TURN_COUNT; turnIndex += 1) {
    const running = turnIndex === TURN_COUNT - 1;
    const turnId = "s" + (sessionIndex + 1) + "-turn-" + (turnIndex + 1);
    const createdAt = 1_700_000_000_000 + sessionIndex * 100_000 + rowId;
    const base = { turnId, createdAt, createdAtSeq: INITIAL_SEQ + rowId };
    rowId += 1;
    rows.push({
      ...base,
      kind: "turnHeader",
      rowId,
      origin: "userInput",
      executionKind: "agent",
      state: running ? "running" : "completedSuccess",
      startedAt: createdAt,
      endedAt: running ? undefined : createdAt + 5_000,
    });
    rowId += 1;
    rows.push({
      ...base,
      kind: "userInput",
      rowId,
      origin: "realUser",
      text: "会话 " + (sessionIndex + 1) + " 第 " + (turnIndex + 1) + " 轮：检查工作区状态并给出结论。",
    });
    rowId += 1;
    rows.push({
      ...base,
      kind: "toolCall",
      rowId,
      toolCallId: "call-" + (sessionIndex + 1) + "-" + turnIndex + "-read",
      toolName: "Read",
      status: "success",
      inputText: '{"file_path":"/workspace/notes.md"}',
      input: { file_path: "/workspace/notes.md" },
      output: { text: "notes ok" },
    });
    rowId += 1;
    rows.push({
      ...base,
      kind: "toolCall",
      rowId,
      toolCallId: "call-" + (sessionIndex + 1) + "-" + turnIndex + "-bash",
      toolName: "Bash",
      status: "success",
      inputText: '{"command":"pnpm lint"}',
      input: { command: "pnpm lint" },
      output: { text: "lint ok" },
    });
    rowId += 1;
    rows.push({
      ...base,
      kind: "assistantText",
      rowId,
      text:
        "第 " + (turnIndex + 1) + " 轮结论：工作区结构稳定，未发现阻塞项。" +
        "这里放一段足够长的正文，让虚拟列表的高度估计与真实布局都参与测量。",
      state: running ? "streaming" : "complete",
    });
  }
  return rows;
}

const MODELS = SESSION_IDS.map((sessionId, index) => ({
  index,
  sessionId,
  topic: "conversation/" + sessionId,
  subscriptionId: "cost-sub-" + (index + 1),
  logEpoch: "cost-epoch",
  revision: 1,
  seq: INITIAL_SEQ,
  rows: buildRows(index),
}));

function makeSnapshot(model) {
  return {
    protocolVersion: 1,
    sessionId: model.sessionId,
    logEpoch: model.logEpoch,
    seq: model.seq,
    revision: model.revision,
    rows: {
      window: model.rows,
      totalCount: model.rows.length,
      firstRowId: model.rows.length > 0 ? model.rows[0].rowId : null,
    },
    queue: { items: [] },
    modelTransition: null,
    pendingCommands: [],
    subagents: { running: [] },
    backgroundWorks: [],
  };
}

function makeTransport(model) {
  return {
    subscribe: async () => ({
      ack: {
        subscriptionId: model.subscriptionId,
        logEpoch: model.logEpoch,
        mode: "snapshot",
      },
    }),
    activate: () => {},
    unsubscribe: async () => {},
    resync: async () => ({ frames: [] }),
    rowsRange: async () => ({
      rows: [],
      atSeq: model.seq,
      atRevision: model.revision,
      atLogEpoch: model.logEpoch,
      hasMore: false,
    }),
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  };
}

const STORES = MODELS.map(
  (model) => new ConversationProjectionStore(model.topic, makeTransport(model)),
);

function deliverSnapshot(model, store) {
  store.handleFrame({
    topic: model.topic,
    subscriptionId: model.subscriptionId,
    fromSeq: 0,
    toSeq: model.seq,
    sentAt: Date.now(),
    payload: { kind: "snapshot", snapshot: makeSnapshot(model) },
  });
}

function findStreamingRowIndex(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === "assistantText" && row.state === "streaming") return index;
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].kind === "assistantText") return index;
  }
  return -1;
}

/** 向指定会话同步推送 count 个 row.upserted 增量。 */
function pushUpdates(sessionIndex, count) {
  if (sessionIndex < 0 || sessionIndex >= MODELS.length) return 0;
  const model = MODELS[sessionIndex];
  const store = STORES[sessionIndex];
  const targetIndex = findStreamingRowIndex(model.rows);
  if (targetIndex < 0) return 0;
  let row = model.rows[targetIndex];
  for (let step = 0; step < count; step += 1) {
    model.seq += 1;
    model.revision += 1;
    row = { ...row, text: row.text + " ·" };
    model.rows[targetIndex] = row;
    store.handleFrame({
      topic: model.topic,
      subscriptionId: model.subscriptionId,
      fromSeq: model.seq - 1,
      toSeq: model.seq,
      sentAt: Date.now(),
      payload: { kind: "deltas", deltas: [{ op: "row.upserted", row }] },
    });
  }
  return count;
}

let updateTimer = null;
function startUpdates(intervalMs) {
  if (updateTimer !== null) return;
  const period = typeof intervalMs === "number" && intervalMs > 0 ? intervalMs : UPDATE_INTERVAL_MS;
  updateTimer = setInterval(() => {
    for (let index = 0; index < MODELS.length; index += 1) pushUpdates(index, 1);
  }, period);
}
function stopUpdates() {
  if (updateTimer === null) return;
  clearInterval(updateTimer);
  updateTimer = null;
}

`;
