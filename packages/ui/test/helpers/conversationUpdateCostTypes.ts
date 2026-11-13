/** 会话更新成本对照的公共类型。 */

export type TimelineKind = "baseline" | "current";
export type RadixKind = "baseline" | "current";
export type DerivedMode = "baseline" | "current";

export interface VariantDefinition {
  id: string;
  timeline: TimelineKind;
  radix: RadixKind;
  derived: DerivedMode;
  note?: string;
}

export interface BaselineSources {
  timeline: string;
  radixSelect: string;
  radixScrollArea: string;
  pendingGuideProjection: string;
  derivedSource: string;
  hashes: Record<string, string>;
}

export interface CurrentSources {
  timeline: string;
  timelineHash: string;
  radixSelect: string;
  radixSelectHash: string;
  radixScrollArea: string;
  radixScrollAreaHash: string;
  sessionPane: string;
  sessionPaneHash: string;
  pendingGuideProjection: string;
  pendingGuideProjectionHash: string;
  sessionPaneDerivedInputs: string;
  sessionPaneDerivedInputsHash: string;
}

/**
 * 浏览器 Event Timing 拆分。三者互不重叠，也不与 CDP Performance / trace 指标相加：
 * inputDelay = processingStart - startTime；handler = processingEnd - processingStart；
 * presentation 为 opaque 的事件总时长减去前两段（仅作同一事件内的观测差）。
 *
 * `durationMs` 是所选单个事件（优先 click）的 Event Timing duration，只用于同场景
 * 分栏比较；**不等于 INP**。INP 需要按 input delay + processing time + presentation
 * delay 的独立口径采集，且不能把嵌套区间相加。
 */
export interface EventTimingSample {
  entries: number;
  inputDelayMs: number | null;
  handlerMs: number | null;
  presentationMs: number | null;
  durationMs: number | null;
}

export interface StepMeasurement {
  id: string;
  kind: "session" | "view";
  expectedSessionId?: string;
  expectedView?: string;
  mode: "warmup" | "measured";
  sampleIndex: number;
  variantId: string;
  /** Playwright 点击 IPC 往返；属于自动化开销，不是产品处理延迟。 */
  clickRoundTripMs: number;
  /** 固定 settle + CDP getMetrics 等测试脚手架时间；不得当作产品性能。 */
  waitAfterClickMs: number;
  /** mark 差值，含上面的自动化与固定等待；只作样本窗口边界。 */
  stepTotalMs: number;
  /**
   * flushSync 包围的同步 React 更新耗时：包含 render、DOM commit 与随之发生的
   * layout，不是 Profiler 的纯 commit 时长。字段名保留兼容，报告口径必须写全。
   */
  reactCommitMs: number | null;
  eventTiming: EventTimingSample;
  state: unknown;
  filesChrome?: unknown;
  /**
   * CDP `Performance.getMetrics` 的原始增量：`*Count` 是次数；`LayoutDuration`、
   * `RecalcStyleDuration`、`TaskDuration`、`ScriptDuration` 的单位是**秒**。
   * 汇总层负责换算为毫秒并以 `*Ms` 命名，原始字段名保持 CDP 原样。
   */
  perfDeltas: Record<string, number>;
  eventEntries: Array<Record<string, number | string>>;
  longTasks: Array<{ startTime: number; duration: number }>;
}

export interface TraceKindMetrics {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface TraceThreadScope {
  /** trace 中识别到的 CrRendererMain 主线程数量；0 表示缺少 thread_name 元数据。 */
  rendererMainThreadCount: number;
  /** true 表示指标跨多个线程或全部线程汇总，不能声称“仅当前 page 的渲染主线程”。 */
  pooledAcrossThreads: boolean;
  note: string;
}

export interface TraceCaptureResult {
  outputPath: string;
  categories: string[];
  durationMs: number;
  eventCount: number;
  parseHtml: TraceKindMetrics;
  updateLayoutTree: TraceKindMetrics;
  layout: TraceKindMetrics;
  paint: TraceKindMetrics;
  /**
   * trace 指标只统计 CrRendererMain（存在元数据时）；多个 renderer 进程或缺少
   * thread_name 时显式标记 pooled，避免把多线程汇总误标成单 page 成本。
   */
  threadScope: TraceThreadScope;
  /**
   * longtask 来源必须显式标注：devtools.timeline 类别不含 RunTask，因此 trace
   * 事件本身无法给出长任务；当前使用同一 trace 样本内的 PerformanceObserver。
   */
  longTask: { count: number; totalMs: number; source: string };
}

export interface TraceSampleSummary extends TraceCaptureResult {
  variantId: string;
  sampleIndex: number;
  /** trace 样本与低开销同变体样本的对照；两栏只并排，不相加。 */
  overhead: {
    traceStepMedianMs: number | null;
    lowOverheadStepMedianMs: number | null;
    traceAutomationMedianMs: number | null;
    lowOverheadAutomationMedianMs: number | null;
    note: string;
  };
}

export interface DerivedStatsSample {
  renders: number;
  knownIdsUnstable: number;
  pendingGuidesUnstable: number;
  guideItemChanges: number;
  knownIdsSize: number;
  visibleQueueIsCurrent: boolean;
}

export interface SampleResult {
  variantId: string;
  sampleIndex: number;
  mode: "warmup" | "measured";
  derivedMode: DerivedMode;
  pageErrors: string[];
  steps: StepMeasurement[];
  derived: {
    completedTurnRenders: number;
    runningTurnRenders: number;
    activeTimelineRenders: number;
    timelineRenders: number;
    metadataOnly: DerivedStatsSample;
    membership: DerivedStatsSample;
    guideSwap: DerivedStatsSample;
  };
  prependCommit: {
    timelineScrollTopGets: number;
    timelineScrollTopSets: number;
    gbcr: number;
    styleInnerHtml: number;
    anyInnerHtml: number;
    timelineScrollTopGetStacks?: string[];
  };
  radix: {
    contentOpen: boolean;
    forcedRerenders: number;
    styleInnerHtml: number;
    anyInnerHtml: number;
    beforeStyleCount: number;
    afterStyleTextLengths: number[];
  };
  scroll: {
    anchorBefore: { scrollTop: number; firstVisibleTurnId: string | null } | null;
    anchorAfter: { scrollTop: number; firstVisibleTurnId: string | null } | null;
    anchorStable: boolean | null;
    collapseBeforeExpanded: string | null;
    collapseAfterExpanded: string | null;
    collapseToggled: boolean | null;
    collapseScrollDelta: number | null;
    collapseDebug?: unknown;
    restoreTarget: number | null;
    restoreActual: number | null;
    restoreDelta: number | null;
    restoreTargetVisibleTurnId?: string | null;
    restoreActualVisibleTurnId?: string | null;
    restoreSetDebug?: unknown;
    restoreMemory?: Record<string, unknown>;
    restoreTrace?: Array<{
      t: number;
      source: string;
      top: number;
      scrollHeight: number;
      clientHeight: number;
      turn: string | null;
      activeSession: string | null;
    }>;
  };
  events: Array<Record<string, number | string>>;
  longTasks: Array<{ startTime: number; duration: number }>;
  syncEntries: Array<{ step: string; reactCommitMs: number }>;
  trace?: TraceCaptureResult;
}

export interface VariantResult {
  definition: VariantDefinition;
  buildKey: string;
  buildMs: number;
  degenerate: boolean;
  note?: string;
  samples: SampleResult[];
}

export interface ConversationUpdateCostResult {
  meta: {
    startedAt: string;
    durationMs: number;
    outDir: string;
    samplesPerVariant: number;
    warmupPerVariant: number;
    updateIntervalMs: number;
    viewport: { width: number; height: number };
    baselineManifestPath: string;
    baselineAvailable: boolean;
    baselineHashes: Record<string, string>;
    currentHashes: Record<string, string>;
  };
  variants: VariantResult[];
  gaps: string[];
  /** 可选的独立 trace 组（baseline/combined 各单样本）；与低开销矩阵并排报告，不做加总。 */
  traces?: TraceSampleSummary[];
}
