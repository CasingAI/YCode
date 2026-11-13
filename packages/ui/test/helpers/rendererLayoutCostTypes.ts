/** Renderer 交互布局成本对照（时间线 / 工具栏 / 侧栏）的公共类型。 */

export type RendererLayoutCostVariant = "prechange" | "current";
export type RendererLayoutCostSurface = "timeline" | "toolbar" | "sidepane";
/** timing 组不带 getter monkeypatch；counters 组只用于计数，不用于时间结论。 */
export type RendererLayoutCostGroup = "timing" | "counters";
export type RendererLayoutCostMode = "warmup" | "measured";

export interface CostCounters {
  /** 按 surface 归属的 getBoundingClientRect 次数。 */
  gbcr: Record<string, number>;
  /** 按 `surface.property` 记录的布局 getter 次数。 */
  gets: Record<string, number>;
  /** 按 `surface.property` 记录的布局 setter 次数。 */
  sets: Record<string, number>;
  /** `dispatchEvent(new Event("scroll"))` 等脚本派发（isTrusted=false）。 */
  syntheticScroll: number;
  /** 所有 isTrusted scroll 事件（含用户滚动与 setter 触发的重排）。 */
  nativeScroll: number;
  /** isTrusted wheel 事件次数；fixture 用真实滚轮时为 >0。 */
  userWheel: number;
  /** isTrusted scroll 且附近没有脚本 setter 的次数（用户滚动）。 */
  userScroll: number;
  /** isTrusted scroll 且紧跟脚本 setter 的次数（程序化滚动）。 */
  scriptScroll: number;
  /** toolbar 根节点 cloneNode 次数（每帧探针）。 */
  toolbarProbeClones: number;
  /** toolbar 父容器中出现 `[aria-hidden][inert]` 探针节点次数。 */
  toolbarProbeAppends: number;
  /** toolbar / sidepane 的属性写入（MutationObserver 观察值）。 */
  attributeWrites: Record<string, number>;
  /** sidepane 新增按钮的 getBoundingClientRect 次数。 */
  sidepaneAddButtonRects: number;
}

export interface EventTimingBreakdown {
  /** 观察器收到的全部条目（含 interactionId=0 的非交互条目）。 */
  rawEntries: number;
  /** interactionId>0 的真实交互条目数。 */
  interactionEntries: number;
  inputDelayMs: number | null;
  handlerMs: number | null;
  /**
   * presentation 是 `duration - (processingEnd - startTime)` 的估计残差，
   * 不是独立测量；分辨率受 Event Timing 100ms 量化与 16ms 观察阈值限制。
   */
  presentationMs: number | null;
  presentationIsEstimate: true;
  durationMs: number | null;
  /** PerformanceObserver durationThreshold；低于该阈值的交互不会进入样本。 */
  thresholdMs: number;
  /** 观察器是否成功安装；未安装时所有数值为 null。 */
  supported: boolean;
}

export interface LongTaskBreakdown {
  supported: boolean;
  entries: number;
  count: number | null;
  totalMs: number | null;
  maxMs: number | null;
}

export interface ScrollTrustBreakdown {
  userWheel: number;
  userScroll: number;
  scriptScroll: number;
  syntheticScroll: number;
  nativeScroll: number;
}

export interface RendererLayoutCostWindow {
  startMark: number;
  endMark: number;
  /** bundle 求值结束时的 performance.now()；窗口起点必须不早于它。 */
  bundleEvalEndMark: number | null;
  /** 窗口从 bundle 求值之后才开始；不把 38.5MB bundle 编译注入算进场景。 */
  excludesBundleEval: boolean;
  /** 最后可观察完成的判据（DOM idle / visible-published / wheels 结束等）。 */
  completion: string;
}

export interface RendererLayoutCostPhases {
  /** Node 侧 addScriptTag 墙钟；只用于解释长任务来源，不进入 stepTotal。 */
  bundleEvalMs: number | null;
  /** 首绘场景：mount 标记到 ready 完成。 */
  mountToReadyMs: number | null;
}

export interface TimelineSignals {
  activeIndex?: number | null;
  sessionId?: string | null;
  scrollTop?: number | null;
  clientHeight?: number | null;
  scrollHeight?: number | null;
  sectionCount?: number | null;
  visibleSectionCount?: number | null;
  stagingSectionCount?: number | null;
  /** 首绘可见区发布次数；成功首绘必须恰好 1。 */
  stagingPublishCount?: number | null;
  /** 隐藏 staging 的测量次数；用于判断「暗处排版只做一次」。 */
  hiddenLayoutCount?: number | null;
  firstPaintStaging?: boolean | null;
  pendingOlder?: boolean | null;
  /** 当前窗口最小 / 最大 rowId 与行数，用于证明成功 prepend 真的扩窗。 */
  minRowId?: number | null;
  maxRowId?: number | null;
  rowCount?: number | null;
  inFlight?: number | null;
  inFlightMax?: number | null;
  firstVisibleTurnId?: string | null;
  restore?: { scrollTop: number; firstVisibleTurnId: string | null } | null;
  fill?: {
    pagesFetched?: number | null;
    /** 只统计 commitPendingOlder 返回 committed=true 的次数。 */
    successfulPrependCommits?: number | null;
    /** 提交尝试次数（可能 retry/作废），与成功次数分开。 */
    attemptedPrependCommits?: number | null;
    olderFillPageCount?: number | null;
  };
}

export interface ToolbarSignals {
  width?: number | null;
  controls?: number | null;
  compact?: number | null;
  modelIcon?: boolean | null;
  providerCompact?: boolean | null;
  modelMaxWidth?: string | null;
  /** fit 应用次数（fixture 完成信号）；缺失时只能退回固定 rAF。 */
  fitVersion?: number | null;
}

export interface SidePaneSignals {
  width?: number | null;
  tabs?: number | null;
  overflow?: boolean | null;
  mask?: string | null;
  scrollLeft?: number | null;
  scrollWidth?: number | null;
  clientWidth?: number | null;
  /** 几何测量轮次（fixture 完成信号）；缺失时只能退回固定 rAF。 */
  geometryVersion?: number | null;
  measureCount?: number | null;
}

export type RendererLayoutCostSignals = TimelineSignals | ToolbarSignals | SidePaneSignals;

export type TurnCounts = Record<string, { count: number; isRunning: boolean }>;

export interface RendererLayoutCostSample {
  variant: RendererLayoutCostVariant;
  surface: RendererLayoutCostSurface;
  caseId: string;
  sampleIndex: number;
  mode: RendererLayoutCostMode;
  group: RendererLayoutCostGroup;
  /** timing 组才允许对时间下结论；缺 fixture 能力时为 false。 */
  timingEligible: boolean;
  fixtureCapabilities: string[];
  phases: RendererLayoutCostPhases;
  window: RendererLayoutCostWindow | null;
  stepTotalMs: number | null;
  eventTiming: EventTimingBreakdown | null;
  perfDeltas: Record<string, number> | null;
  longTask: LongTaskBreakdown | null;
  counters: CostCounters | null;
  scrolls: ScrollTrustBreakdown | null;
  signals: RendererLayoutCostSignals;
  turnCounts: TurnCounts;
  pageErrors: string[];
}

export interface RendererLayoutCostCaseResult {
  caseId: string;
  surface: RendererLayoutCostSurface;
  variant: RendererLayoutCostVariant;
  group: RendererLayoutCostGroup;
  samples: RendererLayoutCostSample[];
}

export interface RendererLayoutCostGroupPlan {
  samples: number;
  warmups: number;
}

export interface RendererLayoutCostCoverage {
  requestedVariants: RendererLayoutCostVariant[];
  requestedCases: string[];
  groups: RendererLayoutCostGroup[];
  /** 请求的 variant×case×group 组合数。 */
  expected: number;
  /** 实际产出 case result 的组合数。 */
  executed: number;
  /** 每个 case 的 timing measured 样本数（缺省视为 0）。 */
  measuredByCase: Record<string, number>;
  missing: string[];
  filtered: boolean;
  smoke: boolean;
  complete: boolean;
}

export interface SourceFingerprint {
  gitHead: string;
  gitBranch: string;
  dirty: boolean;
  dirtyEntries: number;
  /** 测试/harness/build/probes 与被测模块的 sha256。 */
  sourceHashes: Record<string, string>;
  dependencyVersions: Record<string, string>;
  /** esbuild metafile 的输入文件（构建代理提供 metafile 时才有）。 */
  moduleInputs: string[] | null;
  snapshot: {
    manifestPath: string;
    manifestSha256: string;
    manifestSidecarSha256: string | null;
    manifestFileCount: number | null;
    uiModuleRoot: string;
    hashes: Record<string, string>;
    replacedKeys: string[];
    astOnlyKeys: string[];
    notMeasuredKeys: string[];
    currentOnlyHashes: Record<string, string>;
  };
  computedAt: string;
}

export interface RendererLayoutCostBundleMeta {
  variant: RendererLayoutCostVariant;
  surface: RendererLayoutCostSurface;
  bundlePath: string;
  bundleSha256: string;
  buildMs: number;
  moduleInputs: string[] | null;
  /** 启动前注入的完整产品 CSS；同一 outDir 内两个变体必须同哈希。 */
  cssPath: string;
  cssSha256: string;
  cssBytes: number;
  cssCandidates: number;
  /** 排除白名单后的共享 src 树哈希；两个变体必须相同。 */
  sharedSourceTreeSha256: string;
  /** 变体完整源码树哈希（prechange 为共享树叠加白名单快照哈希）。 */
  sourceTreeSha256: string;
  replacedModules: Array<{
    key: string;
    currentSha256: string;
    snapshotSha256: string | null;
    bundled: boolean;
  }>;
  /** prechange 必须恰好是白名单；current 必须为空。 */
  snapshotContentUsed: string[];
  dependencyVersions: Record<string, string>;
  inputProblems: string[];
  parityProblems: string[];
}

export interface RendererLayoutCostMeta {
  startedAt: string;
  durationMs: number;
  outDir: string;
  runId: string;
  smoke: boolean;
  samples: number;
  warmups: number;
  groups: Record<RendererLayoutCostGroup, RendererLayoutCostGroupPlan>;
  viewport: { width: number; height: number };
  manifestPath: string;
  manifestSha256: string;
  prechangeHashes: Record<string, string>;
  currentHashes: Record<string, string>;
  cases: string[];
  variants: RendererLayoutCostVariant[];
  coverage: RendererLayoutCostCoverage;
  fingerprintBefore: SourceFingerprint;
  fingerprintAfter: SourceFingerprint | null;
  /** 构建开始到构建完成期间源码未变；false 时结果不能绑定到同一份代码。 */
  sourceStableDuringBuild: boolean;
  frozen: boolean;
  bundles: RendererLayoutCostBundleMeta[];
  /** 构建期输入图 / 跨变体 parity / 白名单替换问题；正式矩阵要求为空。 */
  buildProblems: string[];
  fixtureCapabilities: string[];
}

export interface RendererLayoutCostResult {
  meta: RendererLayoutCostMeta;
  results: RendererLayoutCostCaseResult[];
  gaps: string[];
}
