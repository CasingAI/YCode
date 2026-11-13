/** 单次独立 trace 组的采集与分栏统计（devtools.timeline，仅测试自启浏览器）。 */
import { writeFile } from "node:fs/promises";
import type { CDPSession } from "playwright-core";

import type {
  EventTimingSample,
  TraceCaptureResult,
  TraceKindMetrics,
  TraceSampleSummary,
  TraceThreadScope,
} from "./conversationUpdateCostTypes.js";

interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

/** 仅保留必要类别，不启用调用栈采样类别（避免 200 帧栈放大被测场景）。 */
const TRACE_CATEGORIES = ["devtools.timeline"];

export function summarizeEventTiming(
  entries: ReadonlyArray<Record<string, number | string>>,
): EventTimingSample {
  const timed = entries.filter((entry) => {
    const processingStart = Number(entry.processingStart);
    const processingEnd = Number(entry.processingEnd);
    return (
      Number.isFinite(processingStart) && processingStart > 0 && Number.isFinite(processingEnd)
    );
  });
  if (timed.length === 0) {
    return {
      entries: entries.length,
      inputDelayMs: null,
      handlerMs: null,
      presentationMs: null,
      durationMs: null,
    };
  }
  // Event Timing 的 duration 是按交互/frame 归一的：pointerover 等非交互条目也会带
  // 同样的 duration。处理耗时必须以真正的 click 主事件为准，否则会把 0.1ms 的
  // pointer 处理误报成整步延迟。
  const handlerOf = (entry: Record<string, number | string>): number =>
    Number(entry.processingEnd) - Number(entry.processingStart);
  const clicks = timed.filter((entry) => entry.name === "click");
  const pool = clicks.length > 0 ? clicks : timed;
  let pick = pool[0];
  for (const entry of pool) {
    if (handlerOf(entry) > handlerOf(pick)) pick = entry;
  }
  const startTime = Number(pick.startTime);
  const processingStart = Number(pick.processingStart);
  const processingEnd = Number(pick.processingEnd);
  const duration = Number(pick.duration);
  const inputDelayMs = processingStart - startTime;
  const handlerMs = processingEnd - processingStart;
  const presentationMs = Math.max(0, duration - (processingEnd - startTime));
  return {
    entries: entries.length,
    inputDelayMs,
    handlerMs,
    presentationMs,
    durationMs: duration,
  };
}

function emptyMetrics(): TraceKindMetrics {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

function addMetric(metrics: TraceKindMetrics, durationMs: number): void {
  metrics.count += 1;
  metrics.totalMs += durationMs;
  if (durationMs > metrics.maxMs) metrics.maxMs = durationMs;
}

function mainThreadKeys(events: readonly TraceEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.ph !== "M" || event.name !== "thread_name") continue;
    const threadName = event.args?.name;
    if (threadName === "CrRendererMain") keys.add(`${event.pid}:${event.tid}`);
  }
  return keys;
}

function threadScopeOf(mainThreads: Set<string>): TraceThreadScope {
  if (mainThreads.size === 0) {
    return {
      rendererMainThreadCount: 0,
      pooledAcrossThreads: true,
      note: "trace 未包含 thread_name 元数据，ParseHTML/Layout 等指标为全部线程汇总，不能声称仅当前 page 的渲染主线程",
    };
  }
  if (mainThreads.size === 1) {
    return {
      rendererMainThreadCount: 1,
      pooledAcrossThreads: false,
      note: "指标仅统计单个 CrRendererMain 渲染主线程，不含其他线程与进程",
    };
  }
  return {
    rendererMainThreadCount: mainThreads.size,
    pooledAcrossThreads: true,
    note: `指标汇总 ${mainThreads.size} 个 CrRendererMain 渲染主线程；无法按 page/进程再细分，不能当作单 page 成本`,
  };
}

export function summarizeTraceEvents(events: readonly TraceEvent[]): {
  parseHtml: TraceKindMetrics;
  updateLayoutTree: TraceKindMetrics;
  layout: TraceKindMetrics;
  paint: TraceKindMetrics;
  threadScope: TraceThreadScope;
  longTask: { count: number; totalMs: number; source: string };
  eventCount: number;
} {
  const mainThreads = mainThreadKeys(events);
  // 有 thread_name 元数据时所有指标都只统计 renderer 主线程，避免把 compositor、
  // worker 或其他 page 的 ParseHTML/Layout 汇总进来；没有元数据时显式标记 pooled。
  const rendererOnly = mainThreads.size > 0;
  const inScope = (event: TraceEvent): boolean =>
    !rendererOnly || mainThreads.has(`${event.pid}:${event.tid}`);
  const metrics = {
    parseHtml: emptyMetrics(),
    updateLayoutTree: emptyMetrics(),
    layout: emptyMetrics(),
    paint: emptyMetrics(),
  };
  // devtools.timeline 默认不含 toplevel RunTask；保留计数路径，调用方需以样本内
  // PerformanceObserver 覆盖并注明来源，不能把 0 当成“没有长任务”。
  const longTask = {
    count: 0,
    totalMs: 0,
    source: "trace events (devtools.timeline 不含 RunTask)",
  };
  for (const event of events) {
    if (event.ph !== "X" || typeof event.dur !== "number") continue;
    if (!inScope(event)) continue;
    const durationMs = event.dur / 1000;
    if (event.name === "ParseHTML") addMetric(metrics.parseHtml, durationMs);
    else if (event.name === "UpdateLayoutTree") addMetric(metrics.updateLayoutTree, durationMs);
    else if (event.name === "Layout") addMetric(metrics.layout, durationMs);
    else if (event.name === "Paint") addMetric(metrics.paint, durationMs);
    else if (event.name === "RunTask" && durationMs >= 50) {
      longTask.count += 1;
      longTask.totalMs += durationMs;
    }
  }
  return {
    ...metrics,
    threadScope: threadScopeOf(mainThreads),
    longTask,
    eventCount: events.length,
  };
}

export interface TraceCollector {
  stop(): Promise<{
    outputPath: string;
    categories: string[];
    durationMs: number;
    eventCount: number;
    metrics: ReturnType<typeof summarizeTraceEvents>;
  }>;
}

/** 只在本测试自己的 CDPSession 上启动；调用方负责隔离 profile 与输出目录。 */
export async function startTimelineTrace(
  session: CDPSession,
  outputPath: string,
): Promise<TraceCollector> {
  const events: TraceEvent[] = [];
  const startedAt = Date.now();
  const onData = (payload: { value: TraceEvent[] }) => {
    if (Array.isArray(payload?.value)) events.push(...payload.value);
  };
  let resolveComplete: (() => void) | null = null;
  const complete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });
  const onComplete = () => resolveComplete?.();
  session.on("Tracing.dataCollected", onData);
  session.on("Tracing.tracingComplete", onComplete);
  await session.send("Tracing.start", {
    traceConfig: { includedCategories: TRACE_CATEGORIES },
  });
  return {
    async stop() {
      await session.send("Tracing.end");
      await complete;
      session.off("Tracing.dataCollected", onData);
      session.off("Tracing.tracingComplete", onComplete);
      await writeFile(outputPath, JSON.stringify({ traceEvents: events }));
      return {
        outputPath,
        categories: TRACE_CATEGORIES,
        durationMs: Date.now() - startedAt,
        eventCount: events.length,
        metrics: summarizeTraceEvents(events),
      };
    },
  };
}

export function toTraceSampleSummary(params: {
  trace: TraceCaptureResult;
  variantId: string;
  sampleIndex: number;
  traceStepMedianMs: number | null;
  lowOverheadStepMedianMs: number | null;
  traceAutomationMedianMs: number | null;
  lowOverheadAutomationMedianMs: number | null;
}): TraceSampleSummary {
  const { trace } = params;
  return {
    ...trace,
    variantId: params.variantId,
    sampleIndex: params.sampleIndex,
    overhead: {
      traceStepMedianMs: params.traceStepMedianMs,
      lowOverheadStepMedianMs: params.lowOverheadStepMedianMs,
      traceAutomationMedianMs: params.traceAutomationMedianMs,
      lowOverheadAutomationMedianMs: params.lowOverheadAutomationMedianMs,
      note: "trace 组与低开销组并排展示，不相加；单样本只说明该次采集开销，不能外推性能提升",
    },
  };
}
