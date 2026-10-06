/* eslint-disable max-lines -- projection/base/recovery/optimistic 必须共享一个原子 store 状态机，拆分会重新引入跨对象竞态。 */
// Per-session projection store（只读 projection store）。
// 唯一写入方是订阅推送；UI 只读。客户端遵守三条规则：
//   1. snapshot → 整体替换，绝不 merge；
//   2. delta 帧仅在区间衔接（frame.fromSeq === snapshot.seq）时 apply，断档不猜、不缓存补偿；
//   3. base 与状态同生共死——断档时状态未被污染，携当前水位重订阅，由服务端裁决 resume/snapshot。
// 除 optimistic overlay（pending 命令展示）外，本 store 不产生任何 conversation 事实。
import {
  applyConversationDeltas,
  parseConversationTopic,
  PROTOCOL_V4_LIMITS,
  type ConversationQueryDirectoryEntry,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationOpenTiming,
  type ConversationTopicFrame,
  type SessionModelTransition,
  type V4ConversationPlanEntry,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { ConversationShareHydrationResult } from "@/v4/conversationTurnNavigatorHelpers.js";
import type { PendingOlderCommitResult } from "@/v4/timelinePrependCommit.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * runtime 换代打断 subscribe 后的退避节奏。
 *
 * CUA Helper 冷启动就绪会 recycleUntilStable → disposeWorkspace 回收 agent
 * runtime，在途 subscribe 被 rejectAll 打断。若把这次瞬态失败定格成 status="error"，
 * 懒启动的 agent 在 dispose 后可能无人拉起，onRuntimeRestart 就不会到达，面板只能靠用户
 * 手点「重新连接」。subscribeConversationV4 走 start-if-needed，重订阅自身会拉起 runtime，
 * 所以这里按 sessionsIndexStore 的既定模式做有界退避。
 */
const RUNTIME_RECYCLE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * rowsRange 的取数上限请求值。
 *
 * 取窗单位是整轮、页大小由单帧体积预算裁决（见 docs/specs/conversation-timeline-turn-window-fill.md），
 * 行数不再是产品指标：请求 schema 兜底上限即可，让字节预算成为唯一的切页判据。
 */
const CONVERSATION_ROWS_RANGE_FETCH_LIMIT = PROTOCOL_V4_LIMITS.rowsRangeMaxLimit;

/**
 * accepted ACK 后等待权威输入投影的宽限期。
 *
 * Core admission 的 ACK 不等待 TurnStarted/QueueItem/userInput 投影；正常情况下这两条
 * 路径只相差一个 renderer/network round-trip。把窗口设为 2s 可以覆盖正常 desktop/mobile
 * 延迟，又能尽快从“CLI 继续工作、订阅完全静默”的半开通道自愈。超时只恢复订阅，不重放命令。
 */
const ACCEPTED_INPUT_PROJECTION_GRACE_MS = 2_000;
const ACCEPTED_INPUT_COMMAND_TYPES = new Set(["sendText"]);

/** 退避耗尽时展示给用户的 lastError（无底层 error 对象可引用的换代路径）。 */
const RUNTIME_RECYCLED_ERROR = "ZCode agent runtime 已被回收，重连未成功";

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/**
 * 是否为 runtime 换代/回收导致的瞬态 subscribe 失败。
 *
 * 三种文案都来自同一次回收：transport 关闭时 ZCodeProtocolClient.rejectAll 打断在途请求
 * （transport closed），复用已回收 client 时 assertNotDisposed 早退（client disposed），
 * 以及 runtime 尚未重新拉起时的 fail-fast（runtime is not running）。
 */
function isRuntimeRecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // 冷订阅可能亲自拉起新 runtime；restart 令在途 ACK 失效后仍须有界重订，不能停在 error。
    message.includes("fault.subscription.runtimeRestarted") ||
    message.includes("ZCode agent transport closed") ||
    message.includes("ZCode Protocol client disposed") ||
    message.includes("ZCode Protocol client is disposed") ||
    message.includes("ZCode Agent runtime is not running")
  );
}

function hasAcceptedInputProjection(
  snapshot: ConversationSnapshot | null,
  commandId: string,
): boolean {
  if (!snapshot) return false;
  if (snapshot.queue.items.some((item) => item.sourceCommandId === commandId)) return true;
  return snapshot.rows.window.some(
    (row) =>
      row.kind === "userInput" && row.origin === "realUser" && row.sourceCommandId === commandId,
  );
}

export type ConversationStoreStatus =
  // subscribe 在途（首连或断档重订阅）。
  | "connecting"
  // 已订阅且帧连续。
  | "live"
  // subscribe 失败，等待 retry()。
  | "error"
  // 已释放（SessionDataLayer 退订后），不再接受任何操作。
  | "closed";

/** optimistic overlay 条目：命令已上行、服务端尚未在投影中确认。 */
export interface OptimisticCommand {
  commandId: string;
  type: string;
  issuedAt: number;
}

export interface ConversationStoreState {
  status: ConversationStoreStatus;
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  /** 首次 conversation subscribe 的低频 Host/CLI timing；不进入 snapshot 事实。 */
  openTiming?: ConversationOpenTiming;
  /** Renderer 首帧 timing；与 snapshot 一起通知，避免 UI 读取到半更新的诊断状态。 */
  rendererTiming?: SessionOpenRendererTiming;
  optimisticCommands: readonly OptimisticCommand[];
  /**
   * 补页未完结标记：取数在途 **或** 已有取回但等滚动静止后才提交的缓冲。
   * 两者都结束时才翻 false，否则 find 自动补页、触发闸门和加载提示会在内容
   * 尚未落入窗口时提前收工。
   */
  loadingOlder: boolean;
  /**
   * 本次 `rowsRange before` 请求在途（不含「已取回、等你提交」的缓冲）。
   *
   * 必须与 `loadingOlder` 分开：补齐事务期间 `loadingOlder` 会一直为真（缓冲未提交），
   * 若拿它当单飞信号，补齐循环在第一页落地后就被判成「还在取」而永远取不到第二页。
   * 补齐循环要的是「此刻能不能再发一次」，那只有这个字段说得清。
   */
  fetchingOlder: boolean;
  /**
   * 已取回、等待「用户无法输入滚动」后并入窗口的更早行。存原始行而非合并结果：
   * 缓冲期间到达的 row.removed / snapshot resync 必须在提交时按当时窗口重新裁决，
   * 预合并会把已被权威侧移除的历史行带回来。
   *
   * **补齐事务**：一次补齐里取到的多页累积在同一个缓冲里，直到「折叠铺满一屏 /
   * 没有更早历史」才由 commitPendingOlder 一次并入。rows 按 rowId 升序去重。
   *
   * - beforeRowId：事务起点游标（= 事务开始时的窗口首行），提交时窗口首行或纪元对不上
   *   就整批作废并要求重取，避免跨纪元拼接或复活已被裁剪的历史行。
   * - nextBeforeRowId：下一页游标 = 已取到的最小 rowId。事务期间窗口不变，若仍拿
   *   窗口首行当游标，第二次请求会取回同一页。
   * - hasMoreOlder：最后一页的 hasMore=false 表示已到真实顶部，补齐停止条件之一。
   */
  pendingOlder: {
    rows: readonly ConversationRow[];
    beforeRowId: number;
    nextBeforeRowId: number | null;
    hasMoreOlder: boolean;
    pages: number;
    logEpoch: string;
  } | null;
  /** 会话计划目录：一条计划文件一条，CLI 已按创建时间降序排好。 */
  sessionPlans: readonly V4ConversationPlanEntry[];
  /** 只用于触发计划目录只读 query，不属于 conversation 协议事实。 */
  planDirectoryRevision: number;
  plansLoading: boolean;
  /** 计划目录查询失败；与 conversation 订阅状态分开，避免把 RPC 失败误显示为空目录。 */
  plansError: string | null;
  /**
   * 问题导航目录（query/directory 的条目）：一条实用户 query 一条，rowId 升序。
   * 数据源与时间线窗口解耦——长会话的 rail 不再要求整段历史进 renderer。
   * running 强调只属于最后一条 query，由条目 kind 表达；增量失效走
   * queryDirectoryRevision（realUser query 增删 / snapshot 整换时递增）。
   */
  queryDirectory: readonly ConversationQueryDirectoryEntry[];
  /** 只用于触发问题导航目录只读 query，不属于 conversation 协议事实。 */
  queryDirectoryRevision: number;
  queryDirectoryLoading: boolean;
  /** 目录查询失败；与 conversation 订阅状态分开，避免把 RPC 失败误显示为空 rail。 */
  queryDirectoryError: string | null;
  /** 跳转换窗代际：loadWindowAround/loadTailWindow 每次整替换窗口时递增，
   * Timeline 据此复位 prepend 块与滚动记忆（与 sessionKey 复位同款语义）。 */
  windowEpoch: number;
  /**
   * 当前窗口是否连着尾部（= 订阅流新行可直接 append 进窗口）。
   *
   * 换窗（loadWindowAround）把窗口搬到中部时置 false；向下补页（loadNewer）
   * 连上尾部、回到尾部（loadTailWindow）、以及订阅流的 row.appended 落进窗口时
   * 置 true。false 期间 Timeline 到底不自动跟随新行，只提供回到尾部入口——
   * 否则中部阅读会被流式新行持续顶走。
   */
  contiguousToTail: boolean;
}

export interface SessionOpenRendererTiming {
  rendererPrepareMs?: number;
  initialFrameTransportMs?: number;
  rendererSnapshotApplyMs?: number;
  snapshotAppliedAt?: number;
}

const INITIAL_STATE: ConversationStoreState = {
  status: "connecting",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  rendererTiming: undefined,
  optimisticCommands: [],
  loadingOlder: false,
  fetchingOlder: false,
  pendingOlder: null,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  plansError: null,
  queryDirectory: [],
  queryDirectoryRevision: 0,
  queryDirectoryLoading: false,
  queryDirectoryError: null,
  windowEpoch: 0,
  contiguousToTail: true,
};

/**
 * 计划目录失效判定。
 *
 * 目录项是文件，所以失效判据只有一个：**有 `ExitPlanMode` 相关的行在动**。落盘发生在
 * 审批门之前，`plan_file_written` 事件会立刻 upsert 那条行（补上 `planFilePath`），因此
 * 文件一落地目录就能重读到，不必等它变成终态——早一步刷新，用户不会在计划已经写好的
 * 那一刻看到一份还少一条的目录。`row.removed` 也保留：分支裁剪后要重读一次。
 */
function shouldInvalidatePlanDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    return delta.row.kind === "toolCall" && delta.row.toolName === "ExitPlanMode";
  });
}

/**
 * 问题导航目录是否需要失效，驱动 query/directory 重查。
 * 判定条件：
 * - snapshot 整体替换 → true（全新状态，目录作废）；
 * - row.removed → true（rewind/分支裁剪改变可导航 query 集合）；
 * - row.appended/row.upserted 命中 realUser userInput → true（新增/变更用户问题）；
 * - 其余 delta（assistant text、tool、reasoning 流式）→ false，不触发重查。
 */
function shouldInvalidateQueryDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return row.kind === "userInput" && row.origin === "realUser";
  });
}

function logSubagentProjectionTransition(
  topic: string,
  previous: ConversationSnapshot | null,
  next: ConversationSnapshot,
  delivery: "snapshot" | "deltas",
): void {
  const previousIds = previous?.subagents?.running.map((item) => item.childSessionId) ?? [];
  const nextIds = next.subagents?.running.map((item) => item.childSessionId) ?? [];
  if (
    previousIds.length === nextIds.length &&
    previousIds.every((childSessionId, index) => childSessionId === nextIds[index])
  ) {
    return;
  }
  // 交互 bug 的根因位于订阅快照交接，不在 React DOM；仅在 Agent 运行集变化时
  // 记录轻量身份与水位，使本地复现能区分合法终态和迟到快照覆盖。
  logger.info("[v4-store] running subagent projection changed", {
    delivery,
    nextBackgroundWorkIds: next.backgroundWorks
      .filter((work) => work.kind === "subagent" && work.status === "running")
      .map((work) => work.childSessionId ?? work.workId),
    nextIds,
    nextSeq: next.seq,
    previousIds,
    previousSeq: previous?.seq ?? null,
    topic,
  });
}

/**
 * 还有更早历史可拉 ⇔ 窗口首行不是全序首行（firstRowId 判定）。
 * 纯函数供 store/组件共用；快照缺失/空窗口/未知 firstRowId 一律 false。
 */
export function hasOlderRows(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

/**
 * 冷快照尾窗是否从一个 turn 的中间截断。turnHeader 是完整 turn 的权威起点；首行允许是
 * lightBoundary，因此不能只判断首行 kind，必须检查首个 turn 在当前窗口里是否已有 header。
 *
 * 整轮取窗后（CLI 按 turnId 对齐切页）这个形态不再出现，本函数随之退役：保留它会诱使
 * 后续改动在补齐循环之外再加一条「补拉首轮」的旁路。
 */
function isColdSnapshotLeadingTurnIncomplete(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const leadingTurnId = snapshot.rows.window[0]?.turnId;
  if (!leadingTurnId) return false;
  return !snapshot.rows.window.some(
    (row) => row.turnId === leadingTurnId && row.kind === "turnHeader",
  );
}

/**
 * 补齐事务的下一页游标：事务缓冲里已取到的最小 rowId；没有缓冲时用窗口首行。
 *
 * 事务期间窗口不变（提交才并入），拿窗口首行当游标会反复取回同一页。
 */
function resolveOlderFetchCursor(
  snapshot: ConversationSnapshot | null,
  pending: ConversationStoreState["pendingOlder"],
): number | null {
  if (pending) return pending.nextBeforeRowId;
  return snapshot?.rows.window[0]?.rowId ?? null;
}

/** 补页行并入事务缓冲：按 rowId 升序去重（事务可能重取同一页）。 */
function appendOlderRowsToFill(
  buffered: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] {
  if (fetched.length === 0) return buffered as ConversationRow[];
  const merged = buffered.length === 0 ? [...fetched] : [...buffered, ...fetched];
  merged.sort((left, right) => left.rowId - right.rowId);
  const deduped: ConversationRow[] = [];
  for (const row of merged) {
    if (deduped.at(-1)?.rowId === row.rowId) continue;
    deduped.push(row);
  }
  return deduped;
}

/**
 * rows/range 结果并入本地窗口（合并规范）：按 rowId 键控、只收
 * 窗口首行之前的行、去重后前插；顺序键 = rowId 升序（全序保证）。
 * 返回 null 表示无可并入行（窗口无变化，调用方不换引用）。
 */
function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return [...older, ...window];
}

/**
 * 外部 store（useSyncExternalStore 兼容：subscribe + getState 返回稳定引用）。
 * 生命周期由 SessionDataLayer 管（引用计数 + keep-warm），组件不直接 new。
 */
// 内存诊断计数器：统计存活 store 数与其 rows.window 行数之和，
// 用于观察窗口数据的内存增长。构造时加入、close() 时移除。
const liveProjectionStores = new Set<ConversationProjectionStore>();
uiMemoryDiagnosticsRegistry.register("projection", () => {
  let rows = 0;
  for (const store of liveProjectionStores) {
    rows += store.countProjectionRows();
  }
  return { stores: liveProjectionStores.size, rows };
});

export class ConversationProjectionStore {
  private state: ConversationStoreState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly modelTransitionListeners = new Set<
    (transition: SessionModelTransition) => void
  >();
  private observedModelTransitionEventId: string | null = null;
  // 订阅代际：并发 connect 只认最新一代，过期结果立即退订防服务端悬挂。
  private generation = 0;
  // 首次订阅尚未拿到 ACK 时，runtime available 只是当前启动流程的正常完成信号；
  // 记录在途数量，避免生命周期通知再次启动 connect，制造同 topic 的订阅替换竞态。
  private connectInFlight = 0;
  /**
   * subscribe ACK mode 持久到该代首个 logical frame；不能只依赖同步 activate 栈，
   * 因为 notification 可在 ACK Promise resolve 后异步到达。
   */
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  /** 当前 subscription 是否已由旧 applied base 或本代 logical frame 证明水位有效。 */
  private subscriptionHasAppliedBase = false;
  private recovery: {
    subscriptionId: string;
    requestInFlight: boolean;
    ackReceived: boolean;
    validFrameSeen: boolean;
    upgradePending: boolean;
    ackMode: "snapshot" | "resume" | null;
    forceSnapshot: boolean;
    postRecoveryGapPending: boolean;
    frameDeadline: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private readonly offAssemblyFault: () => void;
  private readonly offRuntimeRestart: (() => void) | null = null;
  private readonly offRuntimeLifecycle: (() => void) | null = null;
  private runtimeRecycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRecycleRetryAttempt = 0;
  private sessionOpenRendererTiming: SessionOpenRendererTiming = {};
  private initialSubscribeAckAt: number | null = null;
  private planQueryInFlight = false;
  private planQueryPending = false;
  private queryDirectoryInFlight = false;
  private queryDirectoryPending = false;
  /** rows/range 取数在途。单飞闸门用私有字段而非 loadingOlder：后者含缓冲期，不能当闸门。 */
  private fetchingOlder = false;
  /**
   * loadOlder 失败冷却到期时间戳（Date.now() 口径，0 = 无冷却）。
   *
   * 失败若可立即重试，确定性错误（如某行过不了协议校验）会形成自旋：失败 →
   * loadingOlder 回落 → 占位块消失（inset −56 平移）→ 平移发出的 scroll 事件让
   * 预取条件再次满足 → 立即重试，每秒数十次 RPC，占位块 ±56 闪烁、列表上下弹跳
   * （2026-09-28 实测一秒 29 次调用、530 个滚动事件）。预取触发条件不随失败变化，
   * 冷却是这个环唯一的断点。
   */
  private loadOlderRetryAfterMs = 0;
  private static readonly LOAD_OLDER_FAILURE_COOLDOWN_MS = 2_000;
  /** accepted input 的 projection confirmation watchdog；不承载命令，也不生成本地事实。 */
  private readonly acceptedInputProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 分享选择面板全量补齐的终态缓存：同一 logEpoch + 同一 query 集合代际内重复进入
  // 分享选择不再重拉整段历史。query 增删走 queryDirectoryRevision 失效——与 rail
  // 目录同一信号，不再另立 revision。
  private shareHydrationTerminal:
    | (Extract<ConversationShareHydrationResult, { status: "hydrated" | "not-enough-queries" }> & {
        directoryRevision: number;
      })
    | null = null;
  private closed = false;

  constructor(
    readonly topic: string,
    private readonly transport: ConversationTransport,
  ) {
    liveProjectionStores.add(this);
    this.offAssemblyFault = transport.onAssemblyFault((fault) => {
      if (fault.topic === this.topic) {
        this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind);
      }
    });
    // runtime 换代（CLI 进程换代）按 sessionsIndexStore 的约定优先走 lifecycle：dispose
    // 当场只有 unavailable 可观测，onRuntimeRestart 要等新进程 spawn——懒启动下可能永不到达。
    if (transport.onRuntimeLifecycle) {
      this.offRuntimeLifecycle = transport.onRuntimeLifecycle((state) => {
        if (state === "available") this.handleRuntimeAvailable();
        else this.handleRuntimeUnavailable();
      });
      // proxy handoff 不是 runtime 换代，只有 restart 通道携带该语义——
      // ReplaceableConversationTransport.replace() 只广播 runtimeRestartListeners，不发任何
      // lifecycle 事件。若这里因"二选一"完全放弃 restart 通道，远程 workspace 的 proxy 换代
      // 就无人接收：replace() 已 best-effort 退订旧 proxy 的订阅，store 却停在 live + 旧
      // subscriptionId，帧流静默中断且不自愈。
      // 只认 transportReplaced 即可两不重叠：底层 runtime restart 经 bindRuntimeRestartListener
      // 转发时调的是 listener()（reason 为 undefined），已由 lifecycle 的 available 接管。
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) => {
        if (reason !== "transportReplaced") return;
        this.handleRuntimeRestart(reason);
      });
    } else {
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) =>
        this.handleRuntimeRestart(reason),
      );
    }
  }

  getState(): ConversationStoreState {
    return this.state;
  }

  getSessionOpenRendererTiming(): SessionOpenRendererTiming {
    return { ...this.sessionOpenRendererTiming };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onOnlineModelTransition(listener: (transition: SessionModelTransition) => void): () => void {
    this.modelTransitionListeners.add(listener);
    return () => this.modelTransitionListeners.delete(listener);
  }

  private setState(patch: Partial<ConversationStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * 发起/重发订阅。base 取自当前 snapshot 水位（水位不变量：仅当真持有该时刻
   * 一致状态才携带）；forceSnapshot 用于 resume 续传帧仍断档的兜底，丢 base 要全量。
   */
  async connect(
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
      rendererPrepareStartedAt?: number;
    } = {},
  ): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.discardRecovery();
    const snapshot = options.forceSnapshot ? null : this.state.snapshot;
    const connectStartedAt = options.rendererPrepareStartedAt ?? monotonicNow();
    const subscribeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store connect started", {
      event: "v4.conversation.store.connect.started",
      generation,
      hasBase: Boolean(snapshot),
      module: "ui.v4.conversation_projection_store",
      status: "started",
      topic: this.topic,
    });
    this.sessionOpenRendererTiming = {
      rendererPrepareMs: roundedDuration(connectStartedAt, subscribeStartedAt),
    };
    this.initialSubscribeAckAt = null;
    this.connectInFlight += 1;
    this.setState({ status: "connecting", rendererTiming: this.sessionOpenRendererTiming });
    try {
      const result = await this.transport.subscribe({
        topic: this.topic,
        base: snapshot ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq } : undefined,
      });
      if (generation !== this.generation || this.closed) {
        // 过期代际：这份订阅已无人消费，立即退订。
        logger.lifecycle.warn("v4 conversation store connect ACK became stale", {
          event: "v4.conversation.store.connect.stale_ack",
          generation,
          currentGeneration: this.generation,
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId: result.ack.subscriptionId,
          topic: this.topic,
        });
        void this.transport.unsubscribe(result.ack.subscriptionId);
        return;
      }
      // 线上 fault.subscription.notOwned 卡死的根因：connect() 只在发起时
      // discardRecovery，subscribe ACK 的 await 窗口内旧订阅仍可能创建 same-sub recovery；
      // 而 host scope 在新 ACK remember() 时已按 ownershipKey 静默驱逐旧订阅，该 recovery
      // 的在途 resync 注定被 notOwned 拒绝。换代成功即丢弃旧 recovery——新订阅的 initial
      // 会原子替换整个投影，旧恢复流已无意义；否则其迟到失败会把 live 的新订阅打成 error。
      this.discardRecovery();
      this.runtimeRecycleRetryAttempt = 0;
      this.initialSubscribeAckAt = monotonicNow();
      this.setState({
        status: "live",
        subscriptionId: result.ack.subscriptionId,
        lastError: null,
        openTiming: result.ack.openTiming,
      });
      this.subscriptionHasAppliedBase = Boolean(
        snapshot && result.ack.mode === "resume" && result.ack.logEpoch === snapshot.logEpoch,
      );
      // 公共 result 已是 ACK-only；initial 与 online 统一走 notification。
      // subscriptionId 必须先入 store，activate 才能同步释放同一 read 中暂存的 own initial。
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      this.transport.activate(result.ack.subscriptionId);
      logger.lifecycle.info("v4 conversation store connect completed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        event: "v4.conversation.store.connect.completed",
        generation,
        logEpoch: result.ack.logEpoch,
        mode: result.ack.mode,
        module: "ui.v4.conversation_projection_store",
        status: "completed",
        subscriptionId: result.ack.subscriptionId,
        topic: this.topic,
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        // ACK 前 physical batch 已残缺，active same-sub 尚不存在；只能 fresh
        // subscribe 强制 snapshot。最多自动一次，避免异常 peer 造成重试风暴。
        await this.connect({ forceSnapshot: true, initialOverflowRetry: true });
        return;
      }
      if (this.scheduleRuntimeRecycleRetry(error, generation)) {
        logger.lifecycle.warn("v4 conversation store connect retry scheduled", {
          durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
          errorMessage: message,
          event: "v4.conversation.store.connect.retry_scheduled",
          generation,
          module: "ui.v4.conversation_projection_store",
          status: "retrying",
          topic: this.topic,
        });
        logger.warn(`[v4-store] subscribe ${this.topic} 被 runtime 换代打断，退避重连: ${message}`);
        return;
      }
      logger.lifecycle.warn("v4 conversation store connect failed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        errorMessage: message,
        event: "v4.conversation.store.connect.failed",
        generation,
        module: "ui.v4.conversation_projection_store",
        status: "failed",
        topic: this.topic,
      });
      logger.warn(`[v4-store] subscribe ${this.topic} 失败: ${message}`);
      this.setState({ status: "error", lastError: message });
    } finally {
      this.connectInFlight -= 1;
    }
  }

  private clearRuntimeRecycleRetry(): void {
    if (this.runtimeRecycleRetryTimer === null) return;
    clearTimeout(this.runtimeRecycleRetryTimer);
    this.runtimeRecycleRetryTimer = null;
  }

  /**
   * runtime 换代导致的 subscribe 失败：保持 connecting 并有界退避重连。
   * 返回 true 表示已接管本次失败，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleRetry(error: unknown, generation: number): boolean {
    if (!isRuntimeRecycleError(error)) return false;
    return this.scheduleRuntimeRecycleReconnect(generation);
  }

  /**
   * 有界退避重连。重订阅走 start-if-needed（zcodeAgentService.subscribeConversationV4），
   * 自身即可把懒启动的 runtime 拉起来——这是 available 永不到达时唯一的自愈路径。
   * 返回 true 表示已接管，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleReconnect(generation: number): boolean {
    if (this.closed) return false;
    const delayMs = RUNTIME_RECYCLE_RETRY_DELAYS_MS[this.runtimeRecycleRetryAttempt];
    if (delayMs === undefined) return false;
    this.runtimeRecycleRetryAttempt += 1;
    this.clearRuntimeRecycleRetry();
    // 保留旧 snapshot：换代期间投影未被污染，重连成功会原子替换。
    this.setState({ status: "connecting" });
    this.runtimeRecycleRetryTimer = setTimeout(() => {
      this.runtimeRecycleRetryTimer = null;
      if (this.closed || generation !== this.generation) return;
      void this.connect();
    }, delayMs);
    return true;
  }

  /** workspace-dispose 当场：旧 runtime 已死，新的尚不存在，不可重订阅。 */
  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation += 1;
    // 旧 subscriptionId 属于已死 runtime，不得再 unsubscribe（host 侧 owner 已失效）。
    this.setState({ status: "connecting", subscriptionId: null });
    // 不能只 dormant 等 available：agent 懒启动，dispose 后无人拉起时该信号永不到达，
    // 面板会永久转圈。退避重连自身会拉起 runtime；available 先到则复位计数并即时重连。
    if (this.scheduleRuntimeRecycleReconnect(this.generation)) return;
    // 退避额度耗尽（runtime 反复回收）：必须落 error 暴露「重新连接」入口，
    // 否则 connecting 无 timer 就是永久转圈，连手动重试都没有。
    this.setState({ status: "error", lastError: RUNTIME_RECYCLED_ERROR });
  }

  /** 新 runtime 就绪：与 onRuntimeRestart 同义，携原水位重订阅。 */
  private handleRuntimeAvailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    if (this.connectInFlight > 0) {
      // 冷启动 spawn 会在首次 subscribe ACK
      // 返回前广播 available。若这里立即再 connect，服务端会按同一 connection/topic
      // 替换旧订阅；旧 ACK 随即被本地代际防护退订，首帧交接存在竞态，面板可能永久无快照。
      // 当前在途 connect 已经负责完成这次启动，不需要重复重订阅。
      return;
    }
    this.handleRuntimeRestart("runtimeRestart");
  }

  /** 订阅失败后的手动重试入口（pane 层「重新连接」按钮落点）。 */
  retry(): Promise<void> {
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    return this.connect();
  }

  /** row command/query 的 epoch/entity authority 失效，复用 same-sub recovery 收敛。 */
  recoverFromStaleAuthority(): void {
    this.requestRecovery();
  }

  /** SessionDataLayer 帧路由入口。 */
  handleFrame(
    frame: ConversationTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // 代际防护：旧订阅的迟到帧直接丢弃。
    if (frame.subscriptionId !== this.state.subscriptionId) return;
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const frameReceivedAt = monotonicNow();
    // RPC 时序无法证明帧用途。只有 publisher 标记的 initial 才消费
    // awaitingInitial；recovery 必须优先清除此状态，避免 recovery gap 被误判为
    // original subscribe gap 而换新 subId。迟到 online duplicate 不得消费任何闸门。
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      // online overflow snapshot 本身是完整权威状态，可建立 applied base；但它不冒充
      // recovery delivery，flight 仍等待自己的 recovery frame/ACK 收口。
      this.applyFrame(frame, { subscribeMode: null, recovery: false, online: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      // recovery reservation 之后的 online 可能与 ACK 同 read 到达；在 recovery
      // logical frame 已 apply 后看到非重复 online，ACK 收口时必须再开 successor flight。
      if (frame.toSeq > (this.state.snapshot?.seq ?? 0)) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      // ACK(snapshot) 不构成 applied base；initial 丢失后即便数值 fromSeq 恰好
      // 对上旧 projection，也不能把新 epoch delta 拼到旧状态。
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.applyFrame(frame, {
      subscribeMode: initial?.mode ?? null,
      recovery: deliveryKind === "recovery",
      online: deliveryKind === "online",
      frameReceivedAt,
    });
  }

  private applyFrame(
    frame: ConversationTopicFrame,
    context: {
      subscribeMode: "snapshot" | "resume" | null;
      recovery: boolean;
      online: boolean;
      frameReceivedAt?: number;
    },
  ): void {
    if (frame.payload.kind === "snapshot") {
      const hadAppliedBase = this.subscriptionHasAppliedBase;
      logSubagentProjectionTransition(
        this.topic,
        this.state.snapshot,
        frame.payload.snapshot,
        "snapshot",
      );
      // 规则 1：整体替换，扔掉手里的一切换新的。
      // 待提交的补页缓冲**不**在这里丢弃：整窗换新后它的游标多半失配，而丢在提交
      // 时才能把「作废并按新游标重取」这个信号交回调用方（commitPendingOlder 的
      // retry）。在这里清掉会让新窗口的更早内容一直无人拉取。
      // contiguousToTail 回到 true：snapshot 永远是尾窗（订阅流的当前有效分支），
      // 换窗的中部语义只属于 rows/range 整替换，不属于订阅推送。
      this.setState({
        snapshot: frame.payload.snapshot,
        planDirectoryRevision: this.state.planDirectoryRevision + 1,
        queryDirectoryRevision: this.state.queryDirectoryRevision + 1,
        windowEpoch: this.state.windowEpoch + 1,
        contiguousToTail: true,
      });
      this.subscriptionHasAppliedBase = true;
      this.reconcileOptimistic(frame.payload.snapshot);
      this.reconcileAcceptedInputProjection(frame.payload.snapshot);
      // initial 丢失时，publisher 允许完整 online snapshot 建立首个
      // applied base；其中的持久 transition 可能早于本次订阅，不能冒充实时新事件。
      // 首帧只播种观察基线，后续 online 跃迁才通知 pane。
      this.observeModelTransition(frame.payload.snapshot, context.online && hadAppliedBase);
      if (context.subscribeMode !== null && context.frameReceivedAt !== undefined) {
        const snapshotAppliedAt = monotonicNow();
        this.sessionOpenRendererTiming = {
          ...this.sessionOpenRendererTiming,
          ...(this.initialSubscribeAckAt === null
            ? {}
            : {
                initialFrameTransportMs: roundedDuration(
                  this.initialSubscribeAckAt,
                  context.frameReceivedAt,
                ),
              }),
          rendererSnapshotApplyMs: roundedDuration(context.frameReceivedAt, snapshotAppliedAt),
          snapshotAppliedAt,
        };
        this.setState({ rendererTiming: this.sessionOpenRendererTiming });
      }
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    const current = this.state.snapshot;
    // 规则 2a：迟到/重复 logical frame 永远静默丢弃。若它是 ACK 后的 aligned
    // recovery `(N,N]`，则只收口 flight，不重复 apply。
    if (current && frame.toSeq <= current.seq) {
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    if (!current || frame.fromSeq !== current.seq) {
      // 规则 2：断档不猜。状态本身仍是 seq=current.seq 时刻的一致投影（这帧没碰它），
      // 所以 base 仍合法——重订阅让服务端裁决续传或全量；若断档发生在 subscribe 的
      // resume 续传帧上（服务端已裁决过一次仍不衔接），丢 base 强制 snapshot 防循环。
      logger.warn(
        `[v4-store] ${this.topic} 帧断档 fromSeq=${frame.fromSeq} local=${current?.seq ?? "none"}，重订阅`,
      );
      if (context.subscribeMode !== null) {
        // fresh subscribe 的 resume initial 仍断档，换代订阅强制 snapshot；active
        // subscription 的 online/recovery gap 则保持 same-sub。
        void this.connect({ forceSnapshot: true });
      } else {
        this.requestRecovery(context.recovery);
      }
      return;
    }
    const applied = applyConversationDeltas(current, frame.payload.deltas);
    // seq 是快照对齐水位，delta 帧应用完推进到帧右端点。
    const next = { ...applied, seq: frame.toSeq };
    logSubagentProjectionTransition(this.topic, current, next, "deltas");
    // 中部窗口的新行归属：upsert/delta 命中未加载 rowId 在 apply.ts 已是 no-op；
    // 只有 row.appended 会恒落尾——它天然只属于连尾部的窗口。中部窗口收到 append
    // 说明订阅流已推进到该行之后，本窗口不再是中部：直接连回尾部，避免中部阅读
    // 被流式新行持续顶走这个状态永远不同步。
    const reconnectsTail = frame.payload.deltas.some((delta) => delta.op === "row.appended");
    this.setState({
      snapshot: next,
      // 目录项是文件，row.removed 的裁剪边界对它没有意义（文件不会被 rewind 删掉，
      // 而 ListPlans 仍会把它们数进去）：裁剪后交给下面那次失效触发的重读决定结果。
      ...(shouldInvalidatePlanDirectory(frame)
        ? { planDirectoryRevision: this.state.planDirectoryRevision + 1 }
        : {}),
      // real-user query 增删（row.appended/row.upserted 命中 realUser userInput，
      // 或 row.removed 截断分支）递增导航目录 revision，触发目录重查。
      ...(shouldInvalidateQueryDirectory(frame)
        ? { queryDirectoryRevision: this.state.queryDirectoryRevision + 1 }
        : {}),
      ...(reconnectsTail && !this.state.contiguousToTail ? { contiguousToTail: true } : {}),
    });
    this.subscriptionHasAppliedBase = true;
    this.reconcileOptimistic(next);
    this.reconcileAcceptedInputProjection(next);
    this.observeModelTransition(next, context.online);
    if (context.recovery) this.markRecoveryFrameSeen();
  }

  private observeModelTransition(snapshot: ConversationSnapshot, online: boolean): void {
    const transition = snapshot.modelTransition;
    const eventId = transition?.eventId ?? null;
    if (eventId === this.observedModelTransitionEventId) return;
    // 持久 transition 会随 initial/recovery snapshot 重放；若只在 toast 时记 ID，
    // 后续普通 online snapshot 会把旧 fallback 误当新事件。所有合法帧都更新观察基线，
    // 只有首次实时 online 跃迁才通知当前客户端。
    this.observedModelTransitionEventId = eventId;
    if (!online || !transition) return;
    for (const listener of this.modelTransitionListeners) listener(transition);
  }

  /** physical assembly fault：旧 projection 保持可见，active sub 上 single-flight 恢复。 */
  handleAssemblyFault(subscriptionId: string, deliveryKind?: TopicFrameDeliveryKind): void {
    if (this.closed || subscriptionId !== this.state.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // 缺失/伪 deliveryKind 会以 undefined typed fault 到达；若 recovery 已在途，
    // 必须 fail closed/升级，不能把坏 recovery 当普通 burst 后永远等待。
    const recoveryFault =
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null);
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(recoveryFault);
  }

  private requestRecovery(recoveryEvent = false): void {
    if (this.closed) return;
    const subscriptionId = this.state.subscriptionId;
    if (!subscriptionId) {
      void this.connect({ forceSnapshot: true });
      return;
    }
    const existing = this.recovery;
    if (existing) {
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      // recovery logical/fault 可早于 ACK Promise continuation；记住升级意图，
      // ACK=resume 后立即 force snapshot。普通 burst gap 不设置此标记。
      if (existing.requestInFlight || !existing.ackReceived) {
        existing.upgradePending = true;
        return;
      }
      if (existing.ackMode === "resume") this.issueRecovery(existing, true);
      else this.failRecovery("fault.subscription.recoveryFailed");
      return;
    }
    const recovery = {
      subscriptionId,
      requestInFlight: false,
      ackReceived: false,
      validFrameSeen: false,
      upgradePending: false,
      ackMode: null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    this.recovery = recovery;
    this.issueRecovery(recovery, false);
  }

  private issueRecovery(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    this.clearRecoveryDeadline(recovery);
    const snapshot = this.state.snapshot;
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.upgradePending = false;
    recovery.validFrameSeen = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void this.transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          this.subscriptionHasAppliedBase && snapshot
            ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq }
            : null,
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (this.closed || this.recovery !== recovery) return;
        if (result.ack.subscriptionId !== recovery.subscriptionId) {
          throw new Error("fault.subscription.resyncGenerationMismatch");
        }
        recovery.requestInFlight = false;
        recovery.ackReceived = true;
        recovery.ackMode = result.ack.mode;
        this.settleRecovery(recovery);
      })
      .catch((error) => {
        if (this.closed || this.recovery !== recovery) return;
        this.clearRecoveryDeadline(recovery);
        this.recovery = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-store] resync ${this.topic} 失败: ${message}`);
        if (message.includes("fault.subscription.notOwned")) {
          // 线上事件：notOwned 表示某一层已不认这份 subscription
          // ownership（scope 换代静默驱逐、错位 unsubscribe 等状态分歧），是确定性失效
          // 而非瞬态故障；停在 error 等手动重连会让会话永久卡死。本地 snapshot 仍是一致
          // 投影，携当前水位 fresh subscribe 由服务端裁决 resume/snapshot（04-sync 规则 3），
          // 完成自愈。仅对 notOwned 特判，避免瞬态错误引发重连风暴。
          void this.connect();
          return;
        }
        this.setState({ status: "error", lastError: message });
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<ConversationProjectionStore["recovery"]>): void {
    if (this.recovery !== recovery || !recovery.ackReceived || recovery.requestInFlight) return;
    if (recovery.upgradePending) {
      this.clearRecoveryDeadline(recovery);
      if (!recovery.forceSnapshot && recovery.ackMode === "resume") {
        this.issueRecovery(recovery, true);
      } else {
        this.failRecovery("fault.subscription.recoveryFailed");
      }
      return;
    }
    if (recovery.validFrameSeen) {
      this.clearRecoveryDeadline(recovery);
      if (recovery.postRecoveryGapPending) {
        this.issueRecovery(recovery, false);
      } else {
        this.recovery = null;
      }
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (this.closed || this.recovery !== recovery || recovery.validFrameSeen) return;
      if (!recovery.forceSnapshot) this.issueRecovery(recovery, true);
      else this.failRecovery("fault.subscription.recoveryFrameTimedOut");
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
  }

  private clearRecoveryDeadline(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
  ): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  private failRecovery(reasonCode: string): void {
    if (!this.recovery) return;
    this.discardRecovery();
    logger.warn(`[v4-store] ${this.topic} recovery fail-closed: ${reasonCode}`);
    this.setState({ status: "error", lastError: reasonCode });
  }

  private handleRuntimeRestart(reason?: "runtimeRestart" | "transportReplaced"): void {
    if (this.closed) return;
    // transport 已先失效旧 ownership/assembler；旧 transport/runtime subId 不得再 unsubscribe，
    // 直接 fresh subscribe，保留旧 snapshot 直到新 snapshot 原子替换。
    this.generation += 1;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.setState({ status: "connecting", subscriptionId: null });
    // proxy handoff 不等于 CLI runtime 重启；强制 snapshot 会把用户已加载的
    // older rows 替换回 tail window。handoff 保留一致 projection 水位，由服务端按
    // logEpoch/seq 裁决 resume 或 snapshot；真实 runtime restart 仍保持 full subscribe。
    if (reason === "transportReplaced") void this.connect();
    else void this.connect({ forceSnapshot: true });
  }

  /**
   * loadOlder：以窗口首行为游标向上拉一整轮更早行，**只取数不落窗口**。
   *
   * 取回来的行进补齐事务缓冲（`pendingOlder`），等补齐停止条件成立（折叠铺满一屏 /
   * 没有更早历史）后由调用方 commitPendingOlder 一次并入。理由是落窗口会触发前插测高与
   * scrollTop 补偿，若与用户手势并发，补偿读到的是上一个 scroll 事件留下的旧基线，
   * 写入位置因此偏掉一段手指已经滑过的距离（触摸高频滚动下几十 px）。
   *
   * - 单飞：取数在途时重复调用 no-op；事务已开但上一页已落地时允许继续取下一页
   *   （补齐循环靠这个把「不足一屏」补到够），提交仍由调用方显式发起；
   * - 游标推进：事务期间的下一页游标是已取到的最小 rowId（见 resolveOlderFetchCursor）；
   * - 陈旧读防护：atLogEpoch ≠ 当前快照 epoch 的结果整体丢弃（跨 CLI 重启）；
   * - 游标变化：取数期间窗口首行已被改写时当场丢弃，事务期的变化由提交时再校。
   */
  async loadOlder(limit: number = CONVERSATION_ROWS_RANGE_FETCH_LIMIT): Promise<void> {
    if (this.closed || this.fetchingOlder) return;
    // 冷却期内直接跳过，避免失败重试自旋（见字段注释）。
    if (Date.now() < this.loadOlderRetryAfterMs) return;
    const snapshot = this.state.snapshot;
    if (!hasOlderRows(snapshot) || !snapshot) return;
    const pending = this.state.pendingOlder;
    // 事务已探到真实顶部：不再取页，否则补齐循环会一直空转。
    if (pending?.hasMoreOlder === false) return;
    const beforeRowId = resolveOlderFetchCursor(snapshot, pending);
    if (beforeRowId === null) return;
    const sessionId = parseConversationTopic(this.topic);
    if (!sessionId) return;
    this.fetchingOlder = true;
    this.setState({ loadingOlder: true, fetchingOlder: true });
    try {
      const result = await this.transport.rowsRange({
        sessionId,
        beforeRowId,
        limit,
      });
      if (this.closed) return;
      const current = this.state.snapshot;
      if (!current || result.atLogEpoch !== current.logEpoch) {
        logger.warn(
          `[v4-store] ${this.topic} rows/range 纪元不匹配（${result.atLogEpoch}），整体丢弃`,
        );
        return;
      }
      // 事务期间窗口不应被改写；真被改写（rewind / 换窗）则本页作废，由提交时的游标校验收口。
      // 锚点取「事务起点」：第一页没有事务，锚点就是这次请求用的游标（= 请求发出时的
      // 窗口首行）；事务开着时游标已经推进到 pendingOlder.nextBeforeRowId，拿它比窗口首行
      // 会让每一页都在开页处就作废——补齐永远停在第一页。
      const transactionAnchorRowId = pending?.beforeRowId ?? beforeRowId;
      if (current.rows.window[0]?.rowId !== transactionAnchorRowId) return;
      this.loadOlderRetryAfterMs = 0;
      // 取回的行并入补齐事务缓冲：已取到的最小 rowId 成为下一页游标；空页不再推进游标，
      // 由 hasMore=false 让补齐循环停在这里（否则空页会自旋）。
      const rows = appendOlderRowsToFill(pending?.rows ?? [], result.rows);
      const nextBeforeRowId = result.rows[0]?.rowId ?? pending?.nextBeforeRowId ?? null;
      this.setState({
        pendingOlder: {
          rows,
          beforeRowId: pending?.beforeRowId ?? beforeRowId,
          nextBeforeRowId,
          hasMoreOlder: result.hasMore === true && result.rows.length > 0,
          pages: (pending?.pages ?? 0) + 1,
          logEpoch: current.logEpoch,
        },
      });
    } catch (error) {
      // query 只读且可重发：失败不进 error 态，留给下次触发重试；但确定性失败
      // 立即重试会自旋，进冷却（见 loadOlderRetryAfterMs 注释）。
      this.loadOlderRetryAfterMs =
        Date.now() + ConversationProjectionStore.LOAD_OLDER_FAILURE_COOLDOWN_MS;
      logger.warn(
        `[v4-store] rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.fetchingOlder = false;
      if (!this.closed) {
        this.setState({
          loadingOlder: this.state.pendingOlder !== null,
          fetchingOlder: false,
        });
      }
    }
  }

  /**
   * 把缓冲的更早行并入窗口。调用方必须已经保证「用户此刻无法输入滚动」
   * （滚动已静止，且容器在该同步块内不可滚），否则前插测高与 scrollTop 补偿
   * 会与用户手势竞争。
   *
   * 游标或纪元对不上时整批作废并要求重取。作废是必须的：rewind 裁剪与 snapshot
   * resync 都会在缓冲期间改写窗口，预合并或强行并入都会把权威侧已移除的行复活。
   */
  commitPendingOlder(): PendingOlderCommitResult {
    if (this.closed) return { committed: false, retry: false };
    const pending = this.state.pendingOlder;
    if (pending === null) return { committed: false, retry: false };
    const current = this.state.snapshot;
    const next: Partial<ConversationStoreState> = {
      pendingOlder: null,
      loadingOlder: this.fetchingOlder,
    };
    if (
      !current ||
      current.logEpoch !== pending.logEpoch ||
      current.rows.window[0]?.rowId !== pending.beforeRowId
    ) {
      this.setState(next);
      return { committed: false, retry: true };
    }
    const window = mergeOlderRows(current.rows.window, pending.rows);
    if (window === null) {
      this.setState(next);
      return { committed: false, retry: false };
    }
    this.setState({ ...next, snapshot: { ...current, rows: { ...current.rows, window } } });
    return { committed: true };
  }

  /**
   * 跳转换窗：以目标 row 为中心一次取回前后窗口，整替换当前窗口。
   *
   * around 一次往返的理由：两次调用之间可能被 rewind/questions 整批水合交错，
   * 分开取前后半窗会拼出跨纪元的窗口；CLI 侧一次切好，客户端只做纪元校验。
   * 换窗后 pendingOlder 缓冲作废（游标属于旧窗口，提交时也会被判 retry），
   * loadingOlder 同步回落，避免占位块卡住。windowEpoch+1 通知 Timeline 复位
   * prepend 块与滚动记忆；contiguousToTail 按返回的 hasMoreNewer 置位。
   */
  async loadWindowAround(
    rowId: number,
    limit: number = CONVERSATION_ROWS_RANGE_FETCH_LIMIT,
  ): Promise<boolean> {
    if (this.closed) return false;
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return false;
    const requestLogEpoch = snapshot.logEpoch;
    try {
      const result = await this.transport.rowsRange({
        sessionId,
        aroundRowId: rowId,
        limit,
      });
      if (this.closed) return false;
      const current = this.state.snapshot;
      if (
        !current ||
        result.atLogEpoch !== current.logEpoch ||
        current.logEpoch !== requestLogEpoch
      ) {
        logger.warn(`[v4-store] ${this.topic} 换窗纪元不匹配，整体丢弃`, { rowId });
        return false;
      }
      if (result.rows.length === 0) return false;
      this.setState({
        snapshot: { ...current, rows: { ...current.rows, window: [...result.rows] } },
        pendingOlder: null,
        loadingOlder: false,
        fetchingOlder: false,
        windowEpoch: this.state.windowEpoch + 1,
        // around 返回的 hasMoreNewer 为 false ⇔ 窗口已连尾部。
        contiguousToTail: result.hasMoreNewer !== true,
      });
      return true;
    } catch (error) {
      logger.warn(
        `[v4-store] rowsRange around ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * 向下补页：中部窗口未连尾部时，以窗口末行为游标向后取一窗。
   * 只取数不落窗口的语义与 loadOlder 对称——取回的行直接 append 进窗口尾部
   * （尾部追加不需要前插测高，不存在 scrollTop 补偿竞态），但纪元/游标校验同款：
   * 对不上就整批丢弃。连上尾部（hasMoreNewer=false）时 contiguousToTail 置 true。
   */
  async loadNewer(limit: number = CONVERSATION_ROWS_RANGE_FETCH_LIMIT): Promise<void> {
    if (this.closed || this.fetchingOlder || this.state.contiguousToTail) return;
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    const afterRowId = snapshot?.rows.window[snapshot.rows.window.length - 1]?.rowId;
    if (!snapshot || !sessionId || afterRowId === undefined) return;
    this.fetchingOlder = true;
    try {
      const result = await this.transport.rowsRange({
        sessionId,
        afterRowId,
        limit,
      });
      if (this.closed) return;
      const current = this.state.snapshot;
      if (!current || result.atLogEpoch !== current.logEpoch) {
        logger.warn(
          `[v4-store] ${this.topic} rows/range 向下补页纪元不匹配（${result.atLogEpoch}），整体丢弃`,
        );
        return;
      }
      const lastRowId = current.rows.window[current.rows.window.length - 1]?.rowId;
      if (lastRowId !== afterRowId) return;
      const fresh = result.rows.filter((row) => row.rowId > afterRowId);
      if (fresh.length === 0) {
        if (result.hasMoreNewer !== true) this.setState({ contiguousToTail: true });
        return;
      }
      this.setState({
        snapshot: {
          ...current,
          rows: { ...current.rows, window: [...current.rows.window, ...fresh] },
        },
        ...(result.hasMoreNewer !== true ? { contiguousToTail: true } : {}),
      });
    } catch (error) {
      logger.warn(
        `[v4-store] rowsRange after ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.fetchingOlder = false;
    }
  }

  /**
   * 回到尾部：缺省方向取尾窗，整替换当前窗口并贴底。
   * pendingOlder 作废、windowEpoch+1、contiguousToTail=true——与 snapshot 整换同款语义，
   * 但不经过订阅帧，不动 queryDirectoryRevision（目录与窗口解耦，尾窗内容不改变目录）。
   */
  async loadTailWindow(limit: number = CONVERSATION_ROWS_RANGE_FETCH_LIMIT): Promise<void> {
    if (this.closed) return;
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return;
    const requestLogEpoch = snapshot.logEpoch;
    try {
      const result = await this.transport.rowsRange({ sessionId, limit });
      if (this.closed) return;
      const current = this.state.snapshot;
      if (
        !current ||
        result.atLogEpoch !== current.logEpoch ||
        current.logEpoch !== requestLogEpoch
      ) {
        logger.warn(`[v4-store] ${this.topic} 回尾部纪元不匹配，整体丢弃`);
        return;
      }
      this.setState({
        snapshot: { ...current, rows: { ...current.rows, window: [...result.rows] } },
        pendingOlder: null,
        loadingOlder: false,
        fetchingOlder: false,
        windowEpoch: this.state.windowEpoch + 1,
        contiguousToTail: true,
      });
    } catch (error) {
      logger.warn(
        `[v4-store] rowsRange tail ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 完整问题目录（旧导航水合路径，已退役的调用方：导航器改走 query/directory）。
   * 保留给分享选择面板（shareActive）：它要全量行做导出选择，仍需整段历史进窗口。
   * 导航器不得再调用本方法——目录侧信道上线后，全量水合是纯浪费。
   *
   * 问题导航过去直接扫描 renderer 的 tail window，因此 1000 轮会话只显示
   * 已加载的几十轮。这里按协议上限分页读取，但等全部页成功后只换一次 snapshot，
   * 避免每 200 行重建一次 timeline render units 与两个 virtualizer。
   */
  async loadAllOlder(): Promise<ConversationShareHydrationResult> {
    const stale = (logEpoch = this.state.snapshot?.logEpoch ?? "unknown") => ({
      status: "stale" as const,
      logEpoch,
    });
    if (this.closed || this.state.loadingOlder) return stale();
    const snapshot = this.state.snapshot;
    if (!snapshot) return stale();
    // 终态必须同时匹配 logEpoch 与 directoryRevision。logEpoch 表示日志代际，
    // 不表示内容静止——real-user query 增删会递增 revision 使终态失效，允许重新探测。
    const directoryRevision = this.state.queryDirectoryRevision;
    if (
      this.shareHydrationTerminal?.logEpoch === snapshot.logEpoch &&
      this.shareHydrationTerminal.directoryRevision === directoryRevision
    ) {
      return this.shareHydrationTerminal;
    }
    if (!hasOlderRows(snapshot)) return stale(snapshot.logEpoch);
    const sessionId = parseConversationTopic(this.topic);
    const initialBeforeRowId = snapshot.rows.window[0]?.rowId;
    if (!sessionId || initialBeforeRowId === undefined) return stale(snapshot.logEpoch);

    const initialLogEpoch = snapshot.logEpoch;
    const preserveIncompleteLeadingTurn = isColdSnapshotLeadingTurnIncomplete(snapshot);
    const pages: ConversationRow[][] = [];
    let beforeRowId = initialBeforeRowId;
    let committed = false;
    this.setState({ loadingOlder: true });
    logger.debug("[v4-store] 完整问题目录开始补拉历史 rows", {
      beforeRowId,
      loadedRows: snapshot.rows.window.length,
      sessionId,
      totalRows: snapshot.rows.totalCount,
    });

    try {
      while (true) {
        const result = await this.transport.rowsRange({
          sessionId,
          beforeRowId,
          limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
        });
        if (this.closed) return stale(initialLogEpoch);
        const current = this.state.snapshot;
        if (
          !current ||
          result.atLogEpoch !== initialLogEpoch ||
          current.logEpoch !== initialLogEpoch ||
          current.rows.window[0]?.rowId !== initialBeforeRowId
        ) {
          logger.warn("[v4-store] 完整问题目录补拉期间投影游标失效，整批丢弃", {
            currentBeforeRowId: current?.rows.window[0]?.rowId,
            expectedBeforeRowId: initialBeforeRowId,
            resultLogEpoch: result.atLogEpoch,
            sessionId,
          });
          return stale(initialLogEpoch);
        }

        const older = result.rows.filter((row) => row.rowId < beforeRowId);
        const nextBeforeRowId = older[0]?.rowId;
        if (nextBeforeRowId === undefined || nextBeforeRowId >= beforeRowId) {
          logger.warn("[v4-store] 完整问题目录 rows/range 未推进游标，停止补拉", {
            beforeRowId,
            hasMore: result.hasMore,
            sessionId,
          });
          return { status: "retryable-failure", logEpoch: initialLogEpoch };
        }
        pages.push(older);
        beforeRowId = nextBeforeRowId;
        if (!result.hasMore) break;
      }

      const current = this.state.snapshot;
      if (
        !current ||
        current.logEpoch !== initialLogEpoch ||
        current.rows.window[0]?.rowId !== initialBeforeRowId
      ) {
        return stale(initialLogEpoch);
      }
      const olderRows = [...pages].reverse().flat();
      const realUserQueryCount = [...olderRows, ...current.rows.window].reduce(
        (count, row) => (row.kind === "userInput" && row.origin === "realUser" ? count + 1 : count),
        0,
      );
      if (realUserQueryCount < 2) {
        if (preserveIncompleteLeadingTurn) {
          const window = mergeOlderRows(current.rows.window, olderRows);
          if (window === null) return stale(initialLogEpoch);
          committed = true;
          this.setState({
            loadingOlder: false,
            snapshot: { ...current, rows: { ...current.rows, window } },
          });
          // navigator 已经拿到补齐首轮所需的权威 rows，必须在隐藏 rail 前先提交它们。
          logger.debug("[v4-store] 完整问题目录不足两条 query，保留首轮补齐 rows", {
            loadedRows: window.length,
            pages: pages.length,
            sessionId,
          });
        }
        // wire snapshot 只保留最后 60 rows，tail 中的 0/1 条 query 不能证明
        // 完整分支也是单 query。宽屏必须探测到分支起点；确认不足两条后不合并探测页，
        // 避免为一个不会显示的 rail 把完整历史常驻 renderer projection。
        logger.debug("[v4-store] 完整问题目录探测后不足两条 query", {
          pages: pages.length,
          preservedIncompleteLeadingTurn: preserveIncompleteLeadingTurn,
          realUserQueryCount,
          sessionId,
        });
        const result = {
          status: "not-enough-queries" as const,
          logEpoch: initialLogEpoch,
          directoryRevision,
        };
        this.shareHydrationTerminal = result;
        return result;
      }
      const window = mergeOlderRows(current.rows.window, olderRows);
      if (window === null) return stale(initialLogEpoch);
      committed = true;
      this.setState({
        loadingOlder: false,
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
      logger.debug("[v4-store] 完整问题目录历史 rows 补拉完成", {
        loadedRows: window.length,
        pages: pages.length,
        sessionId,
      });
      const result = {
        status: "hydrated" as const,
        logEpoch: initialLogEpoch,
        directoryRevision,
      };
      this.shareHydrationTerminal = result;
      return result;
    } catch (error) {
      logger.warn(
        `[v4-store] 完整问题目录 rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "retryable-failure", logEpoch: initialLogEpoch };
    } finally {
      if (!this.closed && !committed) {
        this.setState({ loadingOlder: false, fetchingOlder: false });
      }
    }
  }

  /**
   * 按本地失效 revision 合并并发的问题导航目录查询（query/directory）。
   * 与 refreshPlans 同构，但多一重 logEpoch 校验：目录数的是投影行，
   * rewind/edit-retry 换纪元会让旧分支条目立刻过期，必须整体丢弃不能写回 UI。
   */
  async refreshQueryDirectory(): Promise<void> {
    if (this.closed) return;
    if (this.queryDirectoryInFlight) {
      this.queryDirectoryPending = true;
      return;
    }
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return;
    const requestedGeneration = this.generation;
    const requestedRevision = this.state.queryDirectoryRevision;
    const requestedLogEpoch = snapshot.logEpoch;
    this.queryDirectoryInFlight = true;
    this.setState({ queryDirectoryLoading: true, queryDirectoryError: null });
    try {
      const entries: ConversationQueryDirectoryEntry[] = [];
      let afterRowId: number | undefined;
      let logEpoch = requestedLogEpoch;
      while (true) {
        const result = await this.transport.queryDirectory({
          sessionId,
          ...(afterRowId === undefined ? {} : { afterRowId }),
          limit: PROTOCOL_V4_LIMITS.queryDirectoryMaxEntries,
        });
        if (this.closed) return;
        if (this.generation !== requestedGeneration) return;
        const current = this.state.snapshot;
        if (!current || result.atLogEpoch !== current.logEpoch) {
          logger.warn(
            `[v4-store] ${this.topic} query/directory 纪元不匹配（${result.atLogEpoch}），整体丢弃`,
          );
          return;
        }
        logEpoch = result.atLogEpoch;
        const page = result.entries.filter(
          (entry) => afterRowId === undefined || entry.rowId > afterRowId,
        );
        const nextAfterRowId = page[page.length - 1]?.rowId;
        if (
          nextAfterRowId === undefined ||
          (afterRowId !== undefined && nextAfterRowId <= afterRowId)
        ) {
          logger.warn("[v4-store] query/directory 未推进游标，停止补拉", { sessionId });
          return;
        }
        entries.push(...page);
        afterRowId = nextAfterRowId;
        if (!result.hasMore) break;
      }
      if (this.state.queryDirectoryRevision !== requestedRevision) {
        this.queryDirectoryPending = true;
        return;
      }
      // 纪元校验在每页都做：最终 logEpoch 即取数水位，落目录前确认未换代。
      const current = this.state.snapshot;
      if (!current || current.logEpoch !== logEpoch) return;
      this.setState({ queryDirectory: entries, queryDirectoryError: null });
    } catch (error) {
      if (!this.closed) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-store] queryDirectory ${this.topic} 失败: ${message}`);
        this.setState({ queryDirectoryError: message });
      }
    } finally {
      this.queryDirectoryInFlight = false;
      if (!this.closed) this.setState({ queryDirectoryLoading: false });
      if (this.queryDirectoryPending && !this.closed) {
        this.queryDirectoryPending = false;
        void this.refreshQueryDirectory();
      }
    }
  }

  /**
   * 按本地失效 revision 合并并发的计划目录查询。
   * 旧计划可能早于 snapshot tail；同时 edit/retry 的 row.removed 会让在途
   * query 立刻过期，必须以 revision + epoch 双重校验，不能把旧分支计划重新写回 UI。
   */
  async refreshPlans(): Promise<void> {
    if (this.closed) return;
    if (this.planQueryInFlight) {
      this.planQueryPending = true;
      return;
    }
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return;
    const requestedGeneration = this.generation;
    const requestedRevision = this.state.planDirectoryRevision;
    this.planQueryInFlight = true;
    this.setState({ plansLoading: true, plansError: null });
    try {
      const result = await this.transport.plans({ sessionId });
      if (this.closed) return;
      if (this.generation !== requestedGeneration) return;
      // 刻意不校验 logEpoch：目录项是磁盘上的文件，投影换纪元（rewind / edit-retry）不会
      // 让文件消失，ListPlans 也照样数得到它们。用纪元把这次结果作废只会让目录停在上一份
      // 旧列表上。真正的并发安全由 generation 与 planDirectoryRevision 两个守卫负责。
      if (this.state.planDirectoryRevision !== requestedRevision) {
        this.planQueryPending = true;
        return;
      }
      this.setState({ sessionPlans: result.plans, plansError: null });
    } catch (error) {
      if (!this.closed) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-store] plans ${this.topic} 失败: ${message}`);
        this.setState({ plansError: message });
      }
    } finally {
      this.planQueryInFlight = false;
      if (!this.closed) this.setState({ plansLoading: false });
      if (this.planQueryPending && !this.closed) {
        this.planQueryPending = false;
        void this.refreshPlans();
      }
    }
  }

  /** 命令上行前登记 overlay（pending/stopping 展示用）。 */
  markCommandPending(command: OptimisticCommand): void {
    if (this.closed) return;
    this.setState({
      optimisticCommands: [...this.state.optimisticCommands, command],
    });
  }

  /**
   * ACK accepted/duplicate 后登记“必须能在权威投影中看见”的输入命令。
   *
   * command RPC 与 conversation topic 是两条独立通路；只有收到后续
   * delta 才能发现 gap，若 topic 在 ACK 后完全静默，CLI 继续工作但 UI 永远等不到 user row。
   * 这里不伪造消息，只在有限窗口后复用既有 same-sub recovery；权威 projection 一旦出现
   * queue/user row，watchdog 立即收口。
   */
  expectAcceptedInputProjection(commandId: string): void {
    if (this.closed || this.acceptedInputProjectionTimers.has(commandId)) return;
    const command = this.state.optimisticCommands.find((item) => item.commandId === commandId);
    if (!command || !ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)) return;
    if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
      this.settleCommand(commandId);
      return;
    }
    const timer = setTimeout(() => {
      this.acceptedInputProjectionTimers.delete(commandId);
      if (
        this.closed ||
        !this.state.optimisticCommands.some((item) => item.commandId === commandId)
      ) {
        return;
      }
      if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
        this.settleCommand(commandId);
        return;
      }
      logger.warn("[v4-store] accepted input projection silent, trigger same-sub recovery", {
        commandId,
        topic: this.topic,
      });
      this.requestRecovery();
    }, ACCEPTED_INPUT_PROJECTION_GRACE_MS);
    this.acceptedInputProjectionTimers.set(commandId, timer);
  }

  private clearAcceptedInputProjectionWatch(commandId: string): void {
    const timer = this.acceptedInputProjectionTimers.get(commandId);
    if (timer !== undefined) clearTimeout(timer);
    this.acceptedInputProjectionTimers.delete(commandId);
  }

  /** 命令被拒/失败等本地收口时移除 overlay。 */
  settleCommand(commandId: string): void {
    this.clearAcceptedInputProjectionWatch(commandId);
    const remaining = this.state.optimisticCommands.filter(
      (command) => command.commandId !== commandId,
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  // 服务端投影出现同 commandId（pendingCommands / userInput.sourceCommandId 锚点）即代表权威侧已接管展示，overlay 条目退场。
  private reconcileOptimistic(snapshot: ConversationSnapshot): void {
    if (this.state.optimisticCommands.length === 0) return;
    const acknowledged = new Set<string>(
      snapshot.pendingCommands.map((command) => command.commandId),
    );
    const inputProjectionIds = new Set<string>();
    for (const item of snapshot.queue.items) {
      inputProjectionIds.add(item.sourceCommandId);
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        acknowledged.add(row.sourceCommandId);
        if (row.origin === "realUser") inputProjectionIds.add(row.sourceCommandId);
      }
    }
    const remaining = this.state.optimisticCommands.filter((command) =>
      ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)
        ? !inputProjectionIds.has(command.commandId)
        : !acknowledged.has(command.commandId),
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  private reconcileAcceptedInputProjection(snapshot: ConversationSnapshot): void {
    for (const commandId of this.acceptedInputProjectionTimers.keys()) {
      if (!hasAcceptedInputProjection(snapshot, commandId)) continue;
      this.clearAcceptedInputProjectionWatch(commandId);
      this.settleCommand(commandId);
    }
  }

  /** 内存诊断：当前 rows.window 行数；只读。 */
  countProjectionRows(): number {
    return this.state.snapshot?.rows.window.length ?? 0;
  }

  /** 退订并终结本 store（仅 SessionDataLayer 调用）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    liveProjectionStores.delete(this);
    const closeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store close started", {
      event: "v4.conversation.store.close.started",
      generation: this.generation,
      module: "ui.v4.conversation_projection_store",
      status: "started",
      subscriptionId: this.state.subscriptionId,
      topic: this.topic,
    });
    this.closed = true;
    this.offAssemblyFault();
    this.offRuntimeRestart?.();
    this.offRuntimeLifecycle?.();
    this.clearRuntimeRecycleRetry();
    for (const timer of this.acceptedInputProjectionTimers.values()) clearTimeout(timer);
    this.acceptedInputProjectionTimers.clear();
    this.modelTransitionListeners.clear();
    this.fetchingOlder = false;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation++;
    const { subscriptionId } = this.state;
    this.setState({ status: "closed", subscriptionId: null });
    if (subscriptionId) {
      try {
        await this.transport.unsubscribe(subscriptionId);
      } catch (error) {
        logger.lifecycle.warn("v4 conversation store close unsubscribe failed", {
          durationMs: roundedDuration(closeStartedAt, monotonicNow()),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.store.close.unsubscribe_failed",
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId,
          topic: this.topic,
        });
        logger.warn(`[v4-store] unsubscribe ${this.topic} 失败（忽略）: ${String(error)}`);
      }
    }
    logger.lifecycle.info("v4 conversation store close completed", {
      durationMs: roundedDuration(closeStartedAt, monotonicNow()),
      event: "v4.conversation.store.close.completed",
      module: "ui.v4.conversation_projection_store",
      status: "completed",
      topic: this.topic,
    });
  }
}
