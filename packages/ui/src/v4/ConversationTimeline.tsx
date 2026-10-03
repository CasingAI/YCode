/* oxlint-disable eslint(max-lines) -- ConversationTimeline 集中承载虚拟滚动、滚动锚定、loadOlder 与 find 高亮协调；拆散会让同一滚动状态跨文件传递。 */
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, ArrowDownToLine } from "lucide-react";
import {
  TID_V4_TIMELINE,
  TID_V4_TIMELINE_BOTTOM,
  TID_V4_TIMELINE_LOAD_OLDER,
  TID_V4_TIMELINE_LOAD_NEWER,
} from "@zcode/shared";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationQueryDirectoryEntry,
  ConversationRow,
  ConversationRowTarget,
  QueueItem,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";
import type { AssistantFeedbackHandler } from "@/v4/ConversationRowView.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import { syncConversationShareSelectionPanelLayout } from "@/v4/conversationShareSelectionPanelLayout.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { splitConversationTimelineLiveTail } from "@/v4/conversationTimelineLiveTail.js";
import { recordConversationTimelineDebugEvent } from "@/v4/conversationTimelineDebug.js";
import { AgentTitleByIdentityMemo } from "@/v4/conversationAssistantWorkItems.js";
import {
  getConversationContentWidthClassName,
  getConversationStatusPanelOffsetClassName,
} from "@/v4/conversationLayout.js";
import {
  buildConversationTurnRenderUnitFrame,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationTurnRenderUnitFrame } from "@/v4/conversationTurnUnitDrafts.js";
import {
  buildConversationTurnNavigatorItems,
  resolveConversationTurnNavigatorActiveQueryRowId,
  type ConversationTurnNavigatorQueryPosition,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  TimelineRowHeightCache,
} from "@/v4/timelineRowHeightCache.js";
import { splitPendingPageIntoBlockTurns } from "@/v4/timelinePrependBlocks.js";
import { estimateConversationTurnHeight } from "@/v4/timelineTurnHeightEstimate.js";
import {
  TimelinePrependCommitGate,
  isTimelineAtTop,
  isTimelinePrependScrollLocked,
  timelineTopInsetAdjustment,
  type PendingOlderCommitResult,
  type TimelinePrependCommitScheduler,
} from "@/v4/timelinePrependCommit.js";
import {
  readChatSessionScrollMemoryState,
  resolveChatSessionScrollRestoreTop,
  saveChatSessionScrollMemoryState,
  type ChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  historyPrefetchTriggerPx,
  initialFollowing,
  isAtBottom,
  prependScrollAdjustment,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  resolveTimelineUserScrollAnchorAdjustment,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldShowBackToBottom,
  shouldShowTimelineHistoryLoading,
  shouldTriggerLoadOlder,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  type TimelineUserScrollAnchor,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";
import {
  TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR,
  TIMELINE_TOGGLE_ANCHOR_WINDOW_MS,
  resolveTimelineContentAnchorAction,
  shouldCompensateTimelineToggleAnchorOnScroll,
  shouldSuppressTimelineScrollToBottom,
  timelineToggleAnchorAdjustment,
} from "@/v4/timelineToggleAnchor.js";
import { timelineContentColumnClass } from "@/v4/timelineContentColumnClass.js";
import {
  TIMELINE_TOP_OCCLUSION_PX,
  resolveJumpOcclusionOffsetPx,
  turnStartsWithWorkflowNotificationCard,
} from "@/v4/timelineTopOcclusion.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";

// memo 组件参数中的 `pendingGuides = []` 会在每次调用时创建新引用，
// 让未传该属性的渲染绕过稳定引用边界；共享只读空数组可保持默认值恒定。
const EMPTY_PENDING_GUIDES: readonly QueueItem[] = [];

const ROW_OVERSCAN = 8;
const RUNNING_WORK_DURATION_TICK_MS = 1000;
const COMPOSER_MESSAGE_MASK_FADE_PX = 24;
const COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96;
const USER_SCROLL_INTENT_TTL_MS = 1200;
const LAYOUT_SCROLL_GUARD_MS = 250;
const CONTENT_WIDTH_RESIZE_SETTLE_MS = 120;
const SCROLL_MEMORY_RESTORE_TOLERANCE_PX = 1;
const USER_SCROLL_ANCHOR_EPSILON_PX = 0.5;
const PREPEND_DEBUG_CONTEXT_TTL_MS = 1000;
const PREPEND_DEBUG_REQUEST_CLEANUP_DELAY_MS = 1000;
const TIMELINE_SCROLL_DEBUG_RUN_ID = "prepend-scroll-debug-v1";
/** 补页占位块的固定高度（px）。必须与占位块内层的 h-* 类一致。 */
const PENDING_HISTORY_SLOT_PX = 56;
/** 无待前插行时的稳定空数组：让预测量 memo 在空态下保持引用不变。 */
const EMPTY_TURN_UNITS: readonly ConversationTurnRenderUnit[] = Object.freeze([]);

/** 提交闸门的浏览器定时器注入。提交要排到下一个 task，不能在调用方栈上直接跑。 */
const BROWSER_COMMIT_SCHEDULER: TimelinePrependCommitScheduler = {
  schedule: (callback, delayMs) => {
    const handle = window.setTimeout(callback, delayMs);
    return () => window.clearTimeout(handle);
  },
};

function scheduleMicrotask(callback: () => void): void {
  // 部分 WebView/最小 DOM 运行时没有 window.queueMicrotask；调度能力应从
  // globalThis 注入，并保留 Promise 微任务降级，避免滚动恢复在 commit 阶段直接中断。
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
}

function isEditableScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

// v4 时间线重写滚动控件时把可访问名称误做成了可见文字，偏离旧版
// 的圆形下箭头样式；这里集中渲染图标按钮，避免两个定位分支再次产生视觉差异。
function ConversationBackToBottomButton({
  className,
  label,
  onClick,
}: {
  className: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      title={label}
      type="button"
      size="icon"
      variant="outline"
      className={cn("rounded-full bg-card hover:bg-card-selected", className)}
      data-testid={TID_V4_TIMELINE_BOTTOM}
      onClick={() =>
        runUserAction({
          input: {
            featureId: "conversation.navigation",
            action: "jump_bottom",
            trigger: "button",
          },
          operation: onClick,
          completed: { resultSource: "local_commit" },
          failureStage: "timeline_scroll",
        })
      }
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}

interface ConversationScrollMemoryScopeSnapshot {
  key: string;
  state: ChatSessionScrollMemoryState;
}

type PendingScrollMemoryRestoreWait = "rows" | "content";

interface PendingScrollMemoryRestore extends ConversationScrollMemoryScopeSnapshot {
  rowWindowKey: string;
  waitFor: PendingScrollMemoryRestoreWait;
}

function resolvePendingScrollMemoryRestoreWait(
  state: ChatSessionScrollMemoryState | null,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  hasRows: boolean,
): PendingScrollMemoryRestoreWait | null {
  if (!state || state.wasPinnedToBottom !== false) return null;
  if (!hasRows || !element) return "rows";

  const restoredTop = resolveChatSessionScrollRestoreTop(state, element);
  return restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX < state.scrollTop ? "content" : null;
}

function canReleasePendingScrollMemoryRestore(
  pendingRestore: PendingScrollMemoryRestore,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  rowCount: number,
  hasOlderRows: boolean,
  rowWindowKey: string,
): boolean {
  if (!element) return false;
  if (pendingRestore.waitFor === "rows" && rowCount === 0) return false;
  const restoredTop = resolveChatSessionScrollRestoreTop(pendingRestore.state, element);
  const targetIsRepresentable =
    restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX >= pendingRestore.state.scrollTop;
  if (targetIsRepresentable || element.scrollHeight >= pendingRestore.state.scrollHeight) {
    return true;
  }
  // 新 lease 的首帧 rows 可能仍是截断尾窗；只要还能拉取更早历史，就继续保留原始
  // 恢复意图，避免把临时 clamp 后的 scrollTop 当成最终阅读锚点。
  return rowCount > 0 && !hasOlderRows && pendingRestore.rowWindowKey !== rowWindowKey;
}

interface ConversationScrollMemoryScopeCaptureProps {
  scopeKey: string | null;
  capture: (previousKey: string | null) => ConversationScrollMemoryScopeSnapshot | null;
  commit: (snapshot: ConversationScrollMemoryScopeSnapshot | null) => void;
}

/** React 的 before-mutation snapshot：scope cleanup 时普通 layout effect 已看到新 DOM。 */
class ConversationScrollMemoryScopeCapture extends Component<
  ConversationScrollMemoryScopeCaptureProps,
  unknown,
  ConversationScrollMemoryScopeSnapshot | null
> {
  getSnapshotBeforeUpdate(
    previousProps: ConversationScrollMemoryScopeCaptureProps,
  ): ConversationScrollMemoryScopeSnapshot | null {
    if (previousProps.scopeKey === this.props.scopeKey) return null;
    return this.props.capture(previousProps.scopeKey);
  }

  componentDidUpdate(
    _previousProps: ConversationScrollMemoryScopeCaptureProps,
    _previousState: unknown,
    snapshot: ConversationScrollMemoryScopeSnapshot | null,
  ): void {
    this.props.commit(snapshot);
  }

  render(): null {
    return null;
  }
}

/** tanstack 默认测量的竖向复刻：优先 ResizeObserver entry（不触发同步布局）。 */
function measureRowHeight(element: Element, entry: ResizeObserverEntry | undefined): number {
  const boxSize = entry?.borderBoxSize?.[0];
  if (boxSize) {
    return Math.round(boxSize.blockSize);
  }
  return Math.round(element.getBoundingClientRect().height);
}

function getUnitHeightCacheKey(unit: ConversationTurnRenderUnit | undefined): string | undefined {
  return unit?.key;
}

interface ConversationTimelineProps {
  rows: readonly ConversationRow[];
  /** CLI 权威 queue 中等待 model-step 注入的 guide；只改变 renderer 落位。 */
  pendingGuides?: readonly QueueItem[];
  /** runtime memory 状态，只交给当前 live turn，不进入历史虚拟列表。 */
  apiRetry?: ApiRetryState | null;
  /** 投影全序行数（rows.totalCount；窗口截断后大于 rows.length，仅用于滚动条估计/诊断）。 */
  totalCount: number;
  /**
   * 会话身份键（sessionId ?? "draft"）。切换时重置滚动锚定与测高缓存——
   * rowId 在不同 session 间会重复，测高缓存禁止跨会话串号。
   */
  sessionKey: string;
  /** renderer-local 滚动记忆 key；draft 为 null，不参与保存或恢复。 */
  scrollMemoryKey?: string | null;
  /** 行渲染上下文（theme/codePreviewSettings/workspacePath）；宿主保证引用稳定。 */
  rowContext: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  /** 还有更早历史可拉（窗口首行 > 全序首行）。 */
  canLoadOlder?: boolean;
  /** 补页未完结（取数在途或已取回但尚未并入窗口），抑制重复触发。 */
  loadingOlder?: boolean;
  /** 拉取更早一窗历史（接近顶部时自动预取）。只取数，不落窗口。 */
  onLoadOlder?: () => Promise<void> | void;
  /**
   * 把已取回但尚未并入窗口的更早行落进来。
   *
   * 由 timeline 在滚动静止时调用：落窗口会触发前插测高与 scrollTop 补偿，
   * 与用户手势并发时补偿会按陈旧基线写入，触摸下表现为「抖一下」。
   * 返回 retry=true 表示这页取自已被改写的窗口，调用方应按新游标重取。
   */
  onCommitPendingOlder?: () => PendingOlderCommitResult;
  /** 已取回、等待前插的更早行是否存在。 */
  hasPendingOlder?: boolean;
  /**
   * 已取回、尚未并入窗口的更早行本体。
   *
   * 前插前必须在一切开始之前就知道这些行有多高，所以它们要先被渲进一个隐藏测量层
   * 量出真高写进测高缓存；高度没量完就不允许前插。只传 hasPendingOlder 的话组件拿不到
   * 行内容，只能拿估值提交——那正是漂移的根因。
   */
  pendingOlderRows?: readonly ConversationRow[];
  /** 目录查询在途（store queryDirectoryLoading）：rail 的 aria-busy 信号，不触发补拉。 */
  queryDirectoryLoading?: boolean;
  /**
   * 问题导航目录条目（store queryDirectory 经 SessionPane 下发）。
   * rail 数据源：与时间线窗口解耦，长会话不再为目录拉取整段历史。
   */
  turnNavigatorDirectory?: readonly ConversationQueryDirectoryEntry[];
  /**
   * 跳转换窗代际（store windowEpoch）：loadWindowAround/loadTailWindow
   * 整替换窗口时递增，Timeline 据此复位 prepend 块与滚动记忆。
   */
  windowEpoch?: number;
  /** 还有更新历史可拉（中部窗口未连尾部时向下补页）。 */
  canLoadNewer?: boolean;
  /** 向下拉取更新一窗（接近底部时自动预取，换窗后未连尾部时）。 */
  onLoadNewer?: () => Promise<void> | void;
  /** 回到尾部：整替换回尾窗并贴底。 */
  onLoadTailWindow?: () => Promise<void> | void;
  /** 跳转到目录目标：未加载时先换窗再定位。 */
  onJumpToDirectoryEntry?: (target: { rowId: number; turnId: string }) => Promise<void> | void;
  /** 与旧 ChatView 对齐：composer dock 属于同一个滚动视口，sticky 到滚动容器底部。 */
  bottomDock?: ReactNode;
  /** 分享选择面板所在的共享父容器；用于把 dock 的真实位置写入同一坐标系。 */
  selectionPanelLayoutContainerRef?: { current: HTMLElement | null };
  /**
   * 锁定背景滚动。
   *
   * 分享选择面板只用 scrim 隔离了正文指针事件，滚动容器仍是 overflow-y-auto，
   * 原生滚动条拖拽和键盘 PageUp/Down 仍能改变 scrollTop，勾选目标会在面板下方漂走。
   */
  backgroundScrollLocked?: boolean;
  /** rows 为空时的可选内容；正式空 session 传空，草稿态传问候语。 */
  emptyState?: ReactNode;
  /**
   * 滚动容器内、消息层之上的常驻内容（分享导入的只读块 + 分割线）。
   *
   * 必须在容器内而不是做成固定横幅，才能与实时对话一起滚动；rows 为空时也要渲染，
   * 所以它落在 emptyState 分支之外。
   */
  headerSlot?: ReactNode;
  /** 草稿态让 emptyState 与同一个 bottomDock 作为整体居中，不重挂 composer。 */
  centerEmptyStateWithDock?: boolean;
  /** 窄屏/粗指针视口保留紧凑居中布局，不复用桌面草稿安全间距。 */
  compactEmptyStateWithDock?: boolean;
  /** 右侧状态面板对消息列的布局模式；auto 由 conversation container query 裁决。 */
  summaryPanelLayout?: "none" | "auto" | "inline";
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  sessionPhase?: SessionPhase;
  /** 宿主可调用的一次性“滚动到底部”动作；不持有 conversation 或跨 renderer 状态。 */
  scrollToBottomActionRef?: { current: (() => void) | null };
  /** 宿主可调用的一次性 query 定位动作；不改变分享面板 view。 */
  scrollToQueryActionRef?: {
    current: ((target: { unitIndex?: number; rowId: number }) => void) | null;
  };
  selectionActions?: {
    enabled: boolean;
    sideActionDisabled?: boolean;
    onAddToCurrentTask: (reference: ConversationSelectionReference) => void;
    onAskInSideChat: (reference: ConversationSelectionReference) => void;
  };
  /** 分享选择阶段的本轮勾选状态；仅桌面分享时间线传入。 */
  shareSelection?: {
    eligibleRowIds: ReadonlySet<number>;
    selectedRowIds: ReadonlySet<number>;
    onToggle: (rowId: number) => void;
  };
  /** 分享选择流程存在时，左侧 rail 由分享面板或 reopen 按钮独占。 */
  hideTurnNavigator?: boolean;
}

/**
 * 虚拟滚动 timeline：动态测高（ResizeObserver 驱动 remeasure）+ 底部锚定 +
 * 「回到底部」。滚动位置/跟随态/测高缓存全部为组件实例状态——多 pane（同会话或
 * 异会话）各自独立，互不干扰；数据订阅共享经 sessionDataLayer lease 处理。
 *
 * React 性能：rows 高频变化（流式 delta），滚动相关回调全部经 ref 读取最新值，
 * 保持稳定引用；跟随态存 ref（每帧变化不触发渲染），仅「回到底部」可见性走 state。
 */
function ConversationTimelineImpl({
  rows,
  pendingGuides = EMPTY_PENDING_GUIDES,
  apiRetry = null,
  totalCount,
  sessionKey,
  scrollMemoryKey = null,
  rowContext,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onCommitPendingOlder,
  hasPendingOlder = false,
  pendingOlderRows,
  queryDirectoryLoading = false,
  turnNavigatorDirectory,
  windowEpoch = 0,
  canLoadNewer = false,
  onLoadNewer,
  onLoadTailWindow,
  onJumpToDirectoryEntry,
  bottomDock,
  selectionPanelLayoutContainerRef,
  backgroundScrollLocked = false,
  emptyState,
  headerSlot,
  centerEmptyStateWithDock = false,
  compactEmptyStateWithDock = false,
  summaryPanelLayout = "none",
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  sessionPhase,
  scrollToBottomActionRef,
  scrollToQueryActionRef,
  selectionActions,
  shareSelection,
  hideTurnNavigator = false,
}: ConversationTimelineProps) {
  const { intl } = useZCodeIntl();
  const showHistoryLoading = shouldShowTimelineHistoryLoading({
    loadingOlder,
    canLoadOlder,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerSlotRef = useRef<HTMLDivElement>(null);
  // headerSlot 高度参与虚拟窗口换算（scrollMargin），必须随内容与宽度变化实时跟进，
  // 否则只读块加载完成或窗口变宽换行后，虚拟行会整体错位。
  //
  // 依赖必须是「有没有 slot」而不是 headerSlot 本身：后者是 ReactNode，宿主传的是内联 JSX，
  // 每次渲染都是新对象，会让 ResizeObserver 在流式输出期间每帧重建。
  const hasHeaderSlot = Boolean(headerSlot);
  const [headerSlotHeight, setHeaderSlotHeight] = useState(0);
  useEffect(() => {
    const element = headerSlotRef.current;
    if (!element) {
      setHeaderSlotHeight(0);
      return;
    }
    const sync = () => {
      const next = element.getBoundingClientRect().height;
      setHeaderSlotHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasHeaderSlot]);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  /**
   * 补页占位块占的高度。它是固定值而不是 ResizeObserver 实测值——这一点是刻意的：
   *
   * 实测会在两个方向上都晚一帧。消失时 React 先卸载块，测高 effect 要等 passive 阶段
   * 才把高度归零，中间那一帧 scrollMargin 仍按旧高度记账，虚拟行与正文会错位 h；
   * 出现时反过来，块已经画出来了而 scrollMargin 还是 0，正文被推下去 h。两次都要等
   * ResizeObserver 回调才纠正，而那一帧用户已经能看见。
   *
   * 固定高度让 scrollMargin 与块的显隐落在同一次 render：补偿 effect 在绘制前完成，
   * 不存在「块在、坐标还没跟上」的中间帧。代价是文案不能换行，所以内层用 truncate
   * 并锁死高度；文案本身只有一句「正在加载更早消息...」，窄屏也不会长到需要换行。
   */
  const pendingHistorySlotHeight = showHistoryLoading ? PENDING_HISTORY_SLOT_PX : 0;
  /**
   * 前插块：staged（待翻转，负偏移隐藏）与 committed（已翻转入流）的 turn 单元。
   *
   * 测量与装载必须是同一个 DOM——用户定的硬约束。所以 staged 与 committed 是
   * 同一个列表位置的状态迁移：同一个 key、同一个节点，翻转只是 wrapper 的
   * className 变化（absolute 负偏移 ↔ 流内），React 复用节点，渲染只发生一次。
   *
   * 补页全量进块：不再按 turnHeader 切分留尾巴，拼好后的整轮在块里合练成完整
   * 一轮再翻转。committed 集合提交时按登记集合命中认领，不复制行数据。
   */
  const [committedPrependTurnIds, setCommittedPrependTurnIds] = useState<readonly string[]>([]);
  const committedPrependTurnIdsRef = useRef(committedPrependTurnIds);
  committedPrependTurnIdsRef.current = committedPrependTurnIds;
  /**
   * 前插块容器的高度（committed 部分；staged 是负偏移，不占容器高度）。
   *
   * 与 headerSlotHeight 同一套 ResizeObserver 模式（0.5px 容差）。提交那一帧由
   * prepend effect 的块分支同步读容器终值优先结算账本，observer 回报同值时账本
   * 已结算、独立补偿 effect 空转——两条路径只有先到的那条生效。
   */
  const [prependBlocksHeight, setPrependBlocksHeight] = useState(0);
  useEffect(() => {
    const element = prependBlocksRef.current;
    if (!element) {
      setPrependBlocksHeight(0);
      return;
    }
    const sync = () => {
      const next = element.getBoundingClientRect().height;
      setPrependBlocksHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [committedPrependTurnIds]);
  /** 顶部所有实心块的总高度：虚拟坐标与 scrollTop 补偿都以它为基准。 */
  const topInsetPx = headerSlotHeight + pendingHistorySlotHeight + prependBlocksHeight;
  // 投影与子智能体标题索引的跨帧缓存。
  //
  // 长历史里每个数据帧都会换一份新的 rows 引用，此前整条投影链每帧全量重算、
  // 所有 turn 的对象引用全换，等于每秒（running 时）或每帧（流式时）把全部已挂载
  // turn 重渲染一遍。两处缓存都只认「行对象是否被 delta 命中」这一个信号——
  // applyConversationDeltas 只替换被改的那一个行对象，未改的原样保留引用。
  // 未变的 turn 因此拿到同一个 unit 对象，ConversationTurnGroup 的浅比较成立。
  const previousUnitFrameRef = useRef<ConversationTurnRenderUnitFrame | undefined>(undefined);
  const agentTitleMemoRef = useRef<AgentTitleByIdentityMemo | null>(null);
  if (agentTitleMemoRef.current === null) {
    agentTitleMemoRef.current = new AgentTitleByIdentityMemo();
  }
  const renderUnits = useMemo(() => {
    const frame = buildConversationTurnRenderUnitFrame(rows, {
      nowMs: liveNowMs,
      sessionPhase,
      previousFrame: previousUnitFrameRef.current,
    });
    previousUnitFrameRef.current = frame;
    return frame.entries.map((entry) => entry.unit);
  }, [liveNowMs, rows, sessionPhase]);
  /**
   * staged 页：补页全量进块暗处合练，不再留 trailing。
   */
  const stagedPageSplit = useMemo(
    () => splitPendingPageIntoBlockTurns(pendingOlderRows ?? [], rows[0]),
    [pendingOlderRows, rows],
  );
  /**
   * staged 单元的渲染帧。独立 previousFrame ref：与主时间线共用会让 staged 的
   * 中间态泄漏进真实帧的 previousFrame，增量 diff 就对不上了。
   */
  const pendingMeasureFrameRef = useRef<ConversationTurnRenderUnitFrame | undefined>(undefined);
  const stagedPrependUnits = useMemo(() => {
    if (stagedPageSplit.blockRows.length === 0) return EMPTY_TURN_UNITS;
    const frame = buildConversationTurnRenderUnitFrame(stagedPageSplit.blockRows, {
      nowMs: liveNowMs,
      sessionPhase,
      previousFrame: pendingMeasureFrameRef.current,
    });
    pendingMeasureFrameRef.current = frame;
    return frame.entries.map((entry) => entry.unit);
  }, [liveNowMs, sessionPhase, stagedPageSplit]);
  /**
   * committed 块：主 frame 里已翻转入块的头部 turn，按登记集合命中认领。
   *
   * 全量进块后跨页整轮会被缝合成完整一轮：窗口首轮在合并后变样（多了后半截行），
   * 按「从头连续前缀」匹配会在第一轮就断、整批块失效。所以这里不按前缀截断，
   * 而是按集合命中从头认领——登记过的 turn id 即使被缝合变样也照样认回来；
   * 失效 id（换代、rewind 后不再出现的 turn）只是命中不了，自然结束，不产生错误显示。
   * 虚拟列表渲染的是去掉这个块之后的 units，scrollMargin（topInsetPx）同步加上
   * 块高，TanStack 的内容坐标系因此整体保持自洽。
   */
  const committedPrependUnits = useMemo(() => {
    if (committedPrependTurnIds.length === 0) return EMPTY_TURN_UNITS;
    const committed = new Set(committedPrependTurnIds);
    const taken: ConversationTurnRenderUnit[] = [];
    for (const unit of renderUnits) {
      if (!committed.has(unit.key)) break;
      taken.push(unit);
    }
    return taken;
  }, [committedPrependTurnIds, renderUnits]);
  const blockUnitCount = committedPrependUnits.length + stagedPrependUnits.length;
  /** 虚拟列表去掉块前缀后的单元；live tail 切分照旧在其上工作。 */
  const { virtualizedUnits, liveUnit, liveUnitIndex } = useMemo(() => {
    const remainder = renderUnits.slice(committedPrependUnits.length);
    const split = splitConversationTimelineLiveTail(remainder);
    return {
      virtualizedUnits: split.virtualizedUnits,
      liveUnit: split.liveUnit,
      liveUnitIndex:
        split.liveUnitIndex === null ? null : split.liveUnitIndex + committedPrependUnits.length,
    };
  }, [committedPrependUnits.length, renderUnits]);
  const hasRunningUnit = useMemo(() => renderUnits.some((unit) => unit.isRunning), [renderUnits]);
  const agentTitleByIdentity = useMemo(
    () => agentTitleMemoRef.current?.resolve(rows) ?? new Map<string, string>(),
    [rows],
  );
  const renderRowContext = useMemo<ConversationRowRenderContext>(
    () => ({ ...rowContext, agentTitleByIdentity }),
    [agentTitleByIdentity, rowContext],
  );
  const turnNavigatorItems = useMemo(
    () =>
      buildConversationTurnNavigatorItems(turnNavigatorDirectory ?? [], {
        assistantEmptyPreview: intl.formatMessage({
          id: "chat.turnNavigator.emptyAssistant",
        }),
        assistantRunningPreview: intl.formatMessage({
          id: "chat.turnNavigator.runningAssistant",
        }),
        userFallbackPreview: intl.formatMessage({
          id: "chat.turnNavigator.userFallback",
        }),
      }),
    [intl, turnNavigatorDirectory],
  );
  const turnNavigatorQueryRowIds = useMemo(
    () => new Set(turnNavigatorItems.map((item) => item.rowId)),
    [turnNavigatorItems],
  );
  const turnNavigatorQueryRowIdsRef = useRef(turnNavigatorQueryRowIds);
  turnNavigatorQueryRowIdsRef.current = turnNavigatorQueryRowIds;
  const centeredEmptyLayout = centerEmptyStateWithDock && renderUnits.length === 0;
  const responsiveCenteredEmptyLayout = centeredEmptyLayout && !compactEmptyStateWithDock;
  // 高频值经 ref 供稳定回调读取（不进依赖数组）。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const unitsRef = useRef(renderUnits);
  unitsRef.current = renderUnits;
  const virtualizedUnitsRef = useRef(virtualizedUnits);
  virtualizedUnitsRef.current = virtualizedUnits;
  const committedPrependUnitsRef = useRef(committedPrependUnits);
  committedPrependUnitsRef.current = committedPrependUnits;
  const liveTailRef = useRef<HTMLDivElement>(null);
  const messageLayerRef = useRef<HTMLDivElement>(null);
  const virtualHistoryRef = useRef<HTMLDivElement>(null);
  const stableContentWidthRef = useRef<number | null>(null);
  const contentWidthResizeActiveRef = useRef(false);
  const contentWidthResizeSettleTimerRef = useRef<number | null>(null);
  const isContentWidthChanging = useCallback(() => {
    const currentContentWidth = virtualHistoryRef.current?.clientWidth ?? null;
    const stableContentWidth = stableContentWidthRef.current;
    return (
      contentWidthResizeActiveRef.current ||
      (currentContentWidth !== null &&
        stableContentWidth !== null &&
        currentContentWidth !== stableContentWidth)
    );
  }, []);
  // loadOlder 相关值经 ref 读取，保持 handleScroll 稳定引用。
  const loadOlderRef = useRef({ canLoadOlder, loadingOlder, onLoadOlder });
  loadOlderRef.current = { canLoadOlder, loadingOlder, onLoadOlder };
  // 向下补页相关值经 ref 读取（中部窗口未连尾部时，接近底部自动 loadNewer）。
  const loadNewerRef = useRef({ canLoadNewer, onLoadNewer });
  loadNewerRef.current = { canLoadNewer, onLoadNewer };
  // staged 单元经 ref 供 runPrependCommit 的空依赖回调读取。
  const stagedPrependUnitsRef = useRef(stagedPrependUnits);
  stagedPrependUnitsRef.current = stagedPrependUnits;
  const commitPendingOlderRef = useRef<(() => PendingOlderCommitResult) | undefined>(
    onCommitPendingOlder,
  );
  commitPendingOlderRef.current = onCommitPendingOlder;
  // 前插提交闸门：只保留位置条件（已到顶部）。取数在途、预测量、提交三段都在
  // pending 窗口内，期间列表锁死；高度量完闸门立刻排程，不再等任何时间窗口。
  const prependCommitGateRef = useRef<TimelinePrependCommitGate | null>(null);
  if (prependCommitGateRef.current === null) {
    prependCommitGateRef.current = new TimelinePrependCommitGate(BROWSER_COMMIT_SCHEDULER);
  }
  /**
   * pending 窗口内用户是否已经抵达顶部。
   *
   * 只在有缓冲的真实用户 scroll 事件里更新，其余时刻无事可做。位置的来源与闸门共用
   * 同一个值——scrollTop 只可能在 scroll 事件里变。
   */
  const [prependReachedTop, setPrependReachedTop] = useState(false);
  /**
   * 抵达顶部即锁滚动，一直锁到内容装载与高度调整全部落定。
   *
   * 这不是提交那一帧的开关——同帧设上又解除，浏览器根本没机会产生一次滚动，锁了等于
   * 没锁。锁住整个窗口的意义在于：等待期间用户无法移动坐标系，等待多久都不会有并发
   * 手势，也就只需要一笔补偿而不是边滚边补。
   */
  const prependPendingLocked = isTimelinePrependScrollLocked(hasPendingOlder, prependReachedTop);
  /**
   * 块提交在途标记：runPrependCommit 的 flushSync 渲染会让 prepend effect 看到一次
   * didPrepend，这条路径的 scrollTop 补偿改由该 effect 的块分支同步结算（容器终值
   * 高度 + totalSize 增量合成一笔）。标记在 effect 里消费即清，防止后续普通 commit
   * 误入块分支。
   */
  const blockCommitInFlightRef = useRef(false);
  /**
   * 落窗口：闸门 → flushSync 单次翻转。锁已由 prependPendingLocked 在整个窗口持有，
   * 这里不再设放。
   *
   * 单笔语义：staged 翻转（className 变化，节点不动）与 store 合入窗口发生在同一次
   * flushSync 里；prepend effect 在同一 commit 的 layout 阶段同步读块容器终值高度，
   * 与 inset 账本的差值加上有符号 totalSize 差值合成一笔 scrollTop 写入。Δ 来自容器实际
   * 高度而不是任何锚点推算——装载的就是量过的那个 DOM，账面与实际不可能不一致。
   *
   * 先 commit 再扩展 committedTurnIds：commit 失败（游标失效要重取）时 staged 页还
   * 没进窗口，此时登记 turn id 会让 committed 集合认领悬空。
   *
   * 块级闸门在排程侧已过；这里不再复核（staged 节点一旦量过就一直量着，不存在
   * 「排程后失效」的窗口）。
   */
  const runPrependCommit = useCallback((): void => {
    const commit = commitPendingOlderRef.current;
    if (!commit) return;
    const stagedTurnIds = stagedPrependUnitsRef.current.map((unit) => unit.key);
    let result: PendingOlderCommitResult = { committed: false, retry: false };
    blockCommitInFlightRef.current = true;
    flushSync(() => {
      result = commit();
      if (result.committed && stagedTurnIds.length > 0) {
        setCommittedPrependTurnIds((current) => [...current, ...stagedTurnIds]);
      }
    });
    blockCommitInFlightRef.current = false;
    // 游标失效说明这页取自已被改写的窗口（rewind / snapshot resync），内容得按
    // 新游标重取。补页平时由 scroll 事件唤醒，而此刻列表锁死，不会有事件。
    if (!result.committed && result.retry) void loadOlderRef.current.onLoadOlder?.();
  }, []);
  const previousLoadingOlderRef = useRef(loadingOlder);
  const followingRef = useRef(initialFollowing());
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<{
    intent: TimelineUserScrollIntent;
    observedAt: number;
  }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  // 用户滚动期间由稳定可见 turn 持有测量补偿权；pending 标记等待下一次 layout commit
  // 消费，避免 TanStack 对每条 ResizeObserver 回调直接改写 scrollTop。
  const userScrollAnchorRef = useRef<TimelineUserScrollAnchor | null>(null);
  const pendingUserScrollAnchorCorrectionRef = useRef(false);
  const layoutScrollGuardUntilRef = useRef(0);
  // 用户点过的折叠触发器及其视口偏移：作用窗口内保持它不动，而不是按内容变化贴底。
  const toggleAnchorRef = useRef<{
    element: Element;
    offsetTop: number;
  } | null>(null);
  const toggleAnchorTimerRef = useRef<number | null>(null);
  const userAdjustedScrollSinceRestoreRef = useRef(false);
  const suppressVirtualizerAdjustmentDuringRestoreRef = useRef(false);
  const latestScrollMemoryStateRef = useRef<{
    key: string;
    state: ChatSessionScrollMemoryState;
  } | null>(null);
  const pendingDetachedScrollRestoreRef = useRef<PendingScrollMemoryRestore | null>(null);
  // 组件「已账目」的 scrollTop——scroll 事件读取值或组件自身
  // 程序化写入（贴底/prepend 平移）后的回读值。贴底 effect 拿它对账未观察滚动
  // （滚动已发生、scroll 事件未派发），防止过期 following=true 把用户/测试的上滚拽回底部。
  const lastObservedScrollTopRef = useRef(0);
  // prepend 锚定基线（上一 commit 的首行/总高度），见下方对账效应。
  const prependAnchorRef = useRef<{
    firstRowId: number | null;
    totalSize: number;
  }>({ firstRowId: null, totalSize: 0 });
  /**
   * scrollTop 已经为哪个顶部 inset 做过补偿。它是那本账：prepend effect 与独立的
   * inset 补偿 effect 共用同一份「已结算」状态，先跑的那个结清，后跑的那个看到
   * 相等就直接退出，于是同一次 commit 不会出现两次补偿。
   */
  const appliedTopInsetRef = useRef(0);
  /**
   * 把账结到 nextInset，并返回本次需要写入 scrollTop 的差值（0 表示无需写入）。
   * 调用方负责真正写 scrollTop——两处写入的簿记不同，但差值只在这里算一次。
   */
  const settleTopInset = useCallback((nextInset: number) => {
    const adjustment = timelineTopInsetAdjustment(appliedTopInsetRef.current, nextInset);
    appliedTopInsetRef.current = nextInset;
    return adjustment;
  }, []);
  const timelineDebugRequestIdRef = useRef(0);
  const pendingPrependDebugRequestIdRef = useRef<number | null>(null);
  const pendingPrependDebugLoadingObservedRef = useRef<number | null>(null);
  const pendingPrependDebugCleanupTimerRef = useRef<number | null>(null);
  const lastPrependDebugContextRef = useRef<{
    requestId: number;
    scrollTopAfter: number | null;
    adjustment: number | null;
    expiresAt: number;
  } | null>(null);
  const clearPendingPrependDebugTimer = useCallback(() => {
    if (pendingPrependDebugCleanupTimerRef.current === null) return;
    window.clearTimeout(pendingPrependDebugCleanupTimerRef.current);
    pendingPrependDebugCleanupTimerRef.current = null;
  }, []);
  const clearPendingPrependDebugRequest = useCallback(
    (requestId: number) => {
      if (pendingPrependDebugRequestIdRef.current !== requestId) return;
      clearPendingPrependDebugTimer();
      pendingPrependDebugRequestIdRef.current = null;
      pendingPrependDebugLoadingObservedRef.current = null;
      lastPrependDebugContextRef.current = null;
    },
    [clearPendingPrependDebugTimer],
  );
  const heightCacheRef = useRef<TimelineRowHeightCache | null>(null);
  if (heightCacheRef.current === null) {
    heightCacheRef.current = new TimelineRowHeightCache();
  }
  /**
   * 前插块容器。staged（负偏移隐藏）与 committed（流内）的 turn 是同一条扁平列表
   * 里的同一批节点，测量与装载同一个 DOM。
   *
   * 没有「staged 已渲染」的独立状态：闸门 effect 与提交回调都跑在 effects / task
   * 阶段，而 effects 只在 commit（DOM + refs 已挂）之后运行——staged DOM 的存在
   * 构造性成立。此前用一个会倒退的布尔来证明它，切会话时置回 false 后再没有
   * 东西能推进（stagedPrependUnits 命中 EMPTY 常量、effect 不触发），闸门永关、
   * pending 永存，loadingOlder 恒真挡死预取、到顶锁死不释放——整个会话无法上滚。
   */
  const prependBlocksRef = useRef<HTMLDivElement | null>(null);
  const [backToBottomVisible, setBackToBottomVisible] = useState(false);
  const [turnNavigatorViewport, setTurnNavigatorViewport] = useState({
    scrollOffsetPx: 0,
    viewportHeightPx: 0,
    activeQueryRowId: undefined as number | undefined,
  });
  const turnNavigatorJumpFrameRef = useRef<number | null>(null);
  const timelineRootRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const shareSelectionPanelLayoutRef = useRef<{
    centerYPx: number;
    maxHeightPx: number;
  } | null>(null);
  // 右侧状态面板完整 inline 展开时，中间消息列和输入 dock 必须使用同一偏移；
  // 否则面板会覆盖正文，而不是并排布局。
  const summaryPanelInlineOffsetClassName =
    getConversationStatusPanelOffsetClassName(summaryPanelLayout);
  const contentWidthClassName = getConversationContentWidthClassName({
    centeredEmptyLayout,
    statusPanelLayout: summaryPanelLayout,
  });

  const syncShareSelectionPanelLayout = useCallback(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    // 选择面板是 SessionPane 的兄弟节点，不能把 CSS 变量写在 Timeline
    // 自身，否则面板拿不到 dock 的真实边界；统一写入共享父容器供两者使用。
    const layout = syncConversationShareSelectionPanelLayout(container, dock);
    const previous = shareSelectionPanelLayoutRef.current;
    if (previous?.centerYPx === layout.centerYPx && previous.maxHeightPx === layout.maxHeightPx) {
      return;
    }
    shareSelectionPanelLayoutRef.current = layout;
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef]);

  useLayoutEffect(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    syncShareSelectionPanelLayout();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncShareSelectionPanelLayout);
      resizeObserver.observe(container);
      resizeObserver.observe(timelineRootRef.current ?? container);
      if (scrollRef.current) resizeObserver.observe(scrollRef.current);
      resizeObserver.observe(dock);
    }

    // ResizeObserver 在部分 Electron flex 布局中可能晚于窗口尺寸变化回调，
    // 因此窗口 resize 也始终触发一次几何同步，保证面板随窗口放大/缩小。
    window.addEventListener("resize", syncShareSelectionPanelLayout);
    return () => {
      window.removeEventListener("resize", syncShareSelectionPanelLayout);
      resizeObserver?.disconnect();
    };
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef, syncShareSelectionPanelLayout]);

  // 目录侧信道上线后，rail 不再需要整段历史：宽度 observer 与全量水合
  // hydration effect 整段退役。目录条目由 store 经 turnNavigatorDirectory 下发，
  // 失效由 queryDirectoryRevision 驱动——时间线不再为目录拉取任何行。
  useEffect(() => {
    if (!hasRunningUnit) {
      return;
    }

    // 运行中的 assistant work 状态文案要显示“工作中 N 秒”并随时间推进；
    // 完成态耗时由协议事实固定，builder 会拒绝把这个 UI 时钟用于已结束轮次。
    setLiveNowMs(Date.now());
    const timer = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, RUNNING_WORK_DURATION_TICK_MS);

    return () => window.clearInterval(timer);
  }, [hasRunningUnit]);

  // 目录水合退役说明见上面那段注释：宽度 observer 与 hydration effect 整段删除。
  // turnNavigatorContainerWidthPx / hydration attempt / retry revision 的 state
  // 一并删除（下面还有引用，逐个清理）。

  useEffect(() => {
    const wasLoading = previousLoadingOlderRef.current;
    previousLoadingOlderRef.current = loadingOlder;
    const requestId = pendingPrependDebugRequestIdRef.current;
    if (loadingOlder) {
      if (requestId !== null) {
        pendingPrependDebugLoadingObservedRef.current = requestId;
      }
      clearPendingPrependDebugTimer();
      return;
    }
    if (wasLoading && requestId !== null) {
      // P4 已在 layout effect 消费成功请求的 requestId；这里只清理没有形成 prepend 的请求。
      clearPendingPrependDebugRequest(requestId);
    }
  }, [clearPendingPrependDebugRequest, clearPendingPrependDebugTimer, loadingOlder]);

  useEffect(() => {
    return () => {
      clearPendingPrependDebugTimer();
    };
  }, [clearPendingPrependDebugTimer]);

  // 补页落窗口：取数回来后 staged 块渲染进容器，到顶即排程提交。
  //
  // 两条唤醒来源，缺一条就会有人永远等在闸门前面：
  // - loadingOlder：取数在途期间缓冲还是空的，必须等取数结束那一次变化；
  // - sessionKey：下面那个清理 effect 会在切会话时 cancel 闸门，这里跟着重跑才能接回来。
  // staged 的「已渲染」不需要独立唤醒：pendingOlderRows 变化 → render/commit（staged DOM
  // 挂载）→ 本 effect 随 hasPendingOlder 变化重跑，时序由 React 的 commit → effects
  // 顺序保证。
  //
  // 每次 request 附带容器实时 scrollTop 对账一次：effects 阶段读到的是布局终值（含
  // 浏览器对内容收缩的 clamp），账本残留的过期非顶值在此被纠正，折叠后不足一屏的
  // 会话也能放行提交。对账双向生效，布局离顶时账本在顶也不放行（见 gate request 注释）。
  useEffect(() => {
    const gate = prependCommitGateRef.current;
    if (!gate) return;
    gate.request(hasPendingOlder, runPrependCommit, scrollRef.current?.scrollTop);
    // 缓冲清空后位置条件作废，否则下一轮补页会在取数刚发出时就沿用上一轮的「已到顶」。
    if (!hasPendingOlder) setPrependReachedTop(false);
  }, [hasPendingOlder, loadingOlder, runPrependCommit, sessionKey]);

  // 切会话 / 换窗时清空 committed 集合并复位前插基线：块内容与 store 行是同一
  // 数据源的派生，窗口换了旧前缀不再成立，必须整体回退让虚拟列表接管。
  // prependAnchor 基线同步归零，否则换窗首行会被误判为前插（didPrepend）吃一笔
  // scrollTop 补偿；测高缓存与投影帧不归零——同会话内 turnId 稳定，留着继续命中。
  useEffect(() => {
    setCommittedPrependTurnIds([]);
    setPrependReachedTop(false);
    prependAnchorRef.current = { firstRowId: null, totalSize: 0 };
    prependCommitGateRef.current?.cancel();
    return () => prependCommitGateRef.current?.cancel();
  }, [sessionKey, windowEpoch]);

  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback(
    (index: number) => virtualizedUnitsRef.current[index]?.key ?? index,
    [],
  );
  // 测高缓存兜底：行卸载重挂（甚至 virtualizer 重建）时用上次真实测量代替固定估计。
  // 还没有测过的 turn 按内容结构估（用户气泡 / 正文长度 / 折叠与展开的工具调用），
  // 不再一律回落 72px 常量——那与实测平均高度差 5 倍量级，首屏期间的总高会持续
  // 暴涨，任何基于高度差的滚动锚点补偿都只是在追一个移动的目标。
  //
  // 必须先查缓存再估算：virtualizer 每次重算 measurements 都会对**所有**下标问一遍
  // estimateSize，而重算在滚动测高和 resize 时很频繁。已测量的轮次只能付出一次
  // Map 查找，不能再白算一遍结构化估算。
  const estimateSize = useCallback((index: number) => {
    const unit = virtualizedUnitsRef.current[index];
    const cacheKey = getUnitHeightCacheKey(unit);
    const cached = cacheKey === undefined ? undefined : heightCacheRef.current?.get(cacheKey);
    if (cached !== undefined) return cached;
    return unit === undefined
      ? DEFAULT_ROW_HEIGHT_ESTIMATE_PX
      : estimateConversationTurnHeight(unit);
  }, []);
  // 动态测高：virtualizer 对窗口内元素挂 ResizeObserver，流式行长高即回调此处；
  // 同时把真实高度写入稳定的 turnId 缓存。
  const measureElement = useCallback(
    (element: Element, entry: ResizeObserverEntry | undefined) => {
      const height = measureRowHeight(element, entry);
      const indexAttr = element.getAttribute("data-index");
      const unit = indexAttr === null ? undefined : virtualizedUnitsRef.current[Number(indexAttr)];
      const cacheKey = getUnitHeightCacheKey(unit);
      const previousHeight =
        cacheKey === undefined ? null : (heightCacheRef.current?.get(cacheKey) ?? null);
      if (cacheKey !== undefined) {
        heightCacheRef.current?.set(cacheKey, height);
      }
      if (previousHeight === null || previousHeight !== height) {
        recordConversationTimelineDebugEvent("A1-measure", {
          index: indexAttr === null ? null : Number(indexAttr),
          measuredHeight: height,
          previousCachedHeight: previousHeight,
          heightDelta: previousHeight === null ? null : height - previousHeight,
          virtualUnitCount: virtualizedUnitsRef.current.length,
          scrollTop: scrollRef.current?.scrollTop ?? null,
          viewportHeight: scrollRef.current?.clientHeight ?? null,
          following: followingRef.current,
          contentWidthChanging: isContentWidthChanging(),
        });
      }
      return height;
    },
    [isContentWidthChanging],
  );

  const clearUserScrollAnchor = useCallback(() => {
    userScrollAnchorRef.current = null;
    pendingUserScrollAnchorCorrectionRef.current = false;
  }, []);

  const getPrependDebugRequestId = useCallback((): number | null => {
    const pendingRequestId = pendingPrependDebugRequestIdRef.current;
    if (pendingRequestId !== null) return pendingRequestId;
    const context = lastPrependDebugContextRef.current;
    if (context === null) return null;
    if (context.expiresAt < Date.now()) {
      lastPrependDebugContextRef.current = null;
      return null;
    }
    return context.requestId;
  }, []);

  const schedulePendingPrependDebugCleanup = useCallback(
    (requestId: number) => {
      if (pendingPrependDebugRequestIdRef.current !== requestId) return;
      clearPendingPrependDebugTimer();
      pendingPrependDebugCleanupTimerRef.current = window.setTimeout(() => {
        pendingPrependDebugCleanupTimerRef.current = null;
        if (pendingPrependDebugRequestIdRef.current !== requestId) return;
        // Promise 可能先于 React 的 loadingOlder 状态提交完成；仍在 loading 时交给
        // loadingOlder effect 统一清理，避免正常请求在 P3/P4 前被误删。
        if (
          loadOlderRef.current.loadingOlder ||
          pendingPrependDebugLoadingObservedRef.current === requestId
        ) {
          return;
        }
        clearPendingPrependDebugRequest(requestId);
      }, PREPEND_DEBUG_REQUEST_CLEANUP_DELAY_MS);
    },
    [clearPendingPrependDebugRequest, clearPendingPrependDebugTimer],
  );

  const hasActiveUserScrollInteraction = useCallback(() => {
    const current = userScrollIntentRef.current;
    return (
      Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS ||
      touchClientYRef.current !== null ||
      scrollbarPointerIdRef.current !== null
    );
  }, []);

  const virtualizer = useVirtualizer({
    count: virtualizedUnits.length,
    getScrollElement,
    estimateSize,
    overscan: ROW_OVERSCAN,
    getItemKey,
    measureElement,
    // headerSlot（分享导入的只读块）与补页占位块都与虚拟列表同处一个滚动容器，
    // 且高度可观。不告知这段偏移，虚拟窗口会按 scrollTop 直接索引 item，
    // 渲染窗口整体偏移一个顶部块的高度，用户滚到的区域会是空白。
    scrollMargin: topInsetPx,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    // 折叠锚点窗口内由 compensateToggleAnchor 独占 scrollTop；virtualizer 的
    // 测高补偿此时写 scroll 会与「点哪留哪」互相拉扯。
    const toggleAnchorActive = toggleAnchorRef.current !== null;
    const suppressAdjustment = suppressVirtualizerAdjustmentDuringRestoreRef.current;
    const contentWidthChanging = isContentWidthChanging();
    const userScrollProtected = hasActiveUserScrollInteraction();
    const userScrollAnchorActive = userScrollAnchorRef.current !== null;
    if (userScrollProtected && userScrollAnchorActive) {
      pendingUserScrollAnchorCorrectionRef.current = true;
    }
    const shouldAdjust = shouldSuppressTimelineScrollToBottom(toggleAnchorActive)
      ? false
      : shouldAdjustVirtualizerForItemSizeChange({
          suppressAdjustment,
          following: followingRef.current,
          contentWidthChanging,
          userScrollProtected,
          itemEnd: item.end,
          scrollTop: scrollRef.current?.scrollTop ?? 0,
        });
    if (shouldAdjust) {
      // virtualizer 即将自行写入补偿；先标记 ensuing scroll 为 layout，避免 pending
      // prepend 基线把这次程序化位移误记为用户滚动。
      const guardUntil = Date.now() + LAYOUT_SCROLL_GUARD_MS;
      layoutScrollGuardUntilRef.current = guardUntil;
      const requestId = getPrependDebugRequestId();
      if (requestId !== null) {
        recordConversationTimelineDebugEvent("P6-programmatic-scroll", {
          runId: TIMELINE_SCROLL_DEBUG_RUN_ID,
          requestId,
          source: "virtualizer-size-adjust",
          itemIndex: item.index,
          itemStart: item.start,
          itemEnd: item.end,
          scrollTop: scrollRef.current?.scrollTop ?? null,
          shouldAdjust,
          guardUntil,
        });
      }
    }
    recordConversationTimelineDebugEvent("A2-size-adjust", {
      itemIndex: item.index,
      itemStart: item.start,
      itemEnd: item.end,
      itemSize: item.size,
      scrollTop: scrollRef.current?.scrollTop ?? null,
      following: followingRef.current,
      contentWidthChanging,
      suppressAdjustment,
      toggleAnchorActive,
      userScrollProtected,
      userScrollAnchorActive,
      userScrollIntent: userScrollIntentRef.current.intent,
      shouldAdjust,
    });
    return shouldAdjust;
  };
  const refreshUserScrollAnchor = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      clearUserScrollAnchor();
      return;
    }
    const measurement = virtualizer.getVirtualItemForOffset(element.scrollTop);
    const unit = measurement ? virtualizedUnitsRef.current[measurement.index] : undefined;
    if (!measurement || !unit || unit.key !== measurement.key) {
      clearUserScrollAnchor();
      return;
    }
    userScrollAnchorRef.current = {
      key: unit.key,
      offsetTop: measurement.start - element.scrollTop,
    };
  }, [clearUserScrollAnchor, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const turnNavigatorVirtualItems: ConversationTurnNavigatorVirtualItem[] = useMemo(() => {
    const unitTurnIdAt = (unitIndex: number): string | undefined => {
      if (unitIndex === liveUnitIndex) return liveUnit?.key;
      return virtualizedUnitsRef.current[unitIndex - committedPrependUnitsRef.current.length]?.key;
    };
    const historyItems = virtualRows.map((row) => {
      // virtualizer 只虚拟化去掉 committed 前缀后的余部，row.index 是余部空间；
      // active 判定按 turn 容器挂目录项，这里补上前缀偏移回到 renderUnits 绝对空间。
      const unitIndex = row.index + committedPrependUnits.length;
      return {
        index: unitIndex,
        size: row.size,
        start: row.start,
        turnId: unitTurnIdAt(unitIndex),
      };
    });
    if (liveUnitIndex === null) return historyItems;
    return [
      ...historyItems,
      {
        index: liveUnitIndex,
        start: totalSize,
        // live tail 不参与 virtualizer 测高；覆盖剩余滚动区即可供目录判定当前轮次。
        size: Number.MAX_SAFE_INTEGER - totalSize,
        turnId: liveUnit?.key,
      },
    ];
  }, [committedPrependUnits.length, liveUnitIndex, totalSize, virtualRows]);
  const mountedRowsKey = useMemo(
    () =>
      [
        ...virtualRows.map((row) => String(row.key)),
        ...(liveUnit === null ? [] : [String(liveUnit.key)]),
      ].join(":"),
    [liveUnit, virtualRows],
  );

  const markProgrammaticScroll = useCallback(
    (source: string = "unknown") => {
      const requestId = getPrependDebugRequestId();
      if (requestId !== null) {
        recordConversationTimelineDebugEvent("P6-programmatic-scroll", {
          runId: TIMELINE_SCROLL_DEBUG_RUN_ID,
          requestId,
          source,
          scrollTop: scrollRef.current?.scrollTop ?? null,
          guardUntil: Date.now() + LAYOUT_SCROLL_GUARD_MS,
        });
      }
      layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
      if (programmaticScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
      }
      programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
        programmaticScrollFrameRef.current = null;
      });
    },
    [getPrependDebugRequestId],
  );

  const commitFollowing = useCallback((following: boolean) => {
    if (followingRef.current === following) return;
    followingRef.current = following;
    setBackToBottomVisible(shouldShowBackToBottom(following, unitsRef.current.length));
  }, []);

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null;
    scrollbarPointerIdRef.current = null;
    clearUserScrollAnchor();
  }, [clearUserScrollAnchor]);

  /** 结束折叠锚点：清引用与释放定时器，后续滚动回到既有语义（用户滚动/贴底）。 */
  const clearToggleAnchor = useCallback(() => {
    toggleAnchorRef.current = null;
    if (toggleAnchorTimerRef.current !== null) {
      window.clearTimeout(toggleAnchorTimerRef.current);
      toggleAnchorTimerRef.current = null;
    }
  }, []);

  const getActiveUserScrollIntent = useCallback((): TimelineUserScrollIntent => {
    const current = userScrollIntentRef.current;
    const interactionActive =
      touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null;
    if (interactionActive) {
      return current.intent === "none" ? "unknown" : current.intent;
    }
    return Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS ? current.intent : "none";
  }, []);

  const markLayoutScrollGuard = useCallback(() => {
    layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
  }, []);

  const markUserScrollIntent = useCallback(
    (intent: TimelineUserScrollIntent) => {
      if (intent === "none") return;
      userScrollIntentRef.current = { intent, observedAt: Date.now() };
      refreshUserScrollAnchor();
      const element = scrollRef.current;
      // running -> terminal 会在同一帧迁移 live tail、折叠工作历史并触发
      // virtualizer 测高。向上滚动必须在 scroll 事件之前先拿走滚动权，否则终态
      // layout effect 会拿过期的 following=true 把用户重新拽到底部。
      if (intent === "awayFromBottom" && element && element.scrollHeight > element.clientHeight) {
        commitFollowing(false);
      }
    },
    [commitFollowing, refreshUserScrollAnchor],
  );

  const handleWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      markUserScrollIntent(timelineWheelScrollIntent(event.deltaY));
    },
    [markUserScrollIntent],
  );

  const handleTouchStartCapture = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    touchClientYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMoveCapture = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const nextClientY = event.touches[0]?.clientY;
      const previousClientY = touchClientYRef.current;
      if (nextClientY === undefined || previousClientY === null) return;
      markUserScrollIntent(timelineTouchScrollIntent(previousClientY, nextClientY));
      touchClientYRef.current = nextClientY;
    },
    [markUserScrollIntent],
  );

  const handleTouchEndCapture = useCallback(() => {
    touchClientYRef.current = null;
  }, []);

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      markUserScrollIntent(
        timelineKeyboardScrollIntent({
          key: event.key,
          shiftKey: event.shiftKey,
          editableTarget: isEditableScrollTarget(event.target),
        }),
      );
    },
    [markUserScrollIntent],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const element = scrollRef.current;
      // 点击折叠组触发器是「保持锚点」的用户交互：登记被点元素，让紧随其后的高度变化
      // 钉住它，而不是按内容变化重新贴底（否则刚点的行会被连续顶到悬浮 Header 下面）。
      const toggleTrigger =
        event.target instanceof Element
          ? event.target.closest(TIMELINE_COLLAPSIBLE_TRIGGER_SELECTOR)
          : null;
      if (toggleTrigger && element) {
        clearToggleAnchor();
        clearUserScrollAnchor();
        toggleAnchorRef.current = {
          element: toggleTrigger,
          offsetTop:
            toggleTrigger.getBoundingClientRect().top - element.getBoundingClientRect().top,
        };
        toggleAnchorTimerRef.current = window.setTimeout(() => {
          toggleAnchorRef.current = null;
          toggleAnchorTimerRef.current = null;
        }, TIMELINE_TOGGLE_ANCHOR_WINDOW_MS);
      }
      // 内容区点击（尤其 composer 发送）不是滚动意图；只有 scrollbar/空白命中
      // scroll container 自身时才登记未知方向，随后由真实 scroll 落点裁决。
      if (event.target !== event.currentTarget) return;
      scrollbarPointerIdRef.current = event.pointerId;
      markUserScrollIntent("unknown");
    },
    [clearToggleAnchor, clearUserScrollAnchor, markUserScrollIntent],
  );

  const handlePointerEndCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrollbarPointerIdRef.current === event.pointerId) {
      scrollbarPointerIdRef.current = null;
    }
  }, []);

  const syncMessageLayerMask = useCallback((element: HTMLDivElement) => {
    const messageLayer = messageLayerRef.current;
    if (!messageLayer) return;

    if (
      isAtBottom({
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      })
    ) {
      // 贴底时消息已经位于正常文档流末尾，不会经过 sticky composer；
      // 继续保留 mask 会无意义地淡出最后一条消息，只有离底滚动时才需要遮罩。
      messageLayer.style.maskImage = "none";
      messageLayer.style.webkitMaskImage = "none";
      return;
    }

    const viewportHeight = element.clientHeight;
    const transparentStart = Math.max(
      0,
      viewportHeight - COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
    );
    const opaqueEnd = Math.max(0, transparentStart - COMPOSER_MESSAGE_MASK_FADE_PX);
    const viewportTopInLayer = Math.max(0, element.scrollTop - messageLayer.offsetTop);
    const maskImage = `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`;

    // dock 的透明 padding 能保留分屏 focus ring，但消息会从留白透出；
    // mask 必须随 scroll viewport 对齐且只裁消息层，不能裁掉 sticky composer 与按钮。
    messageLayer.style.maskImage = maskImage;
    messageLayer.style.webkitMaskImage = maskImage;
    messageLayer.style.maskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.webkitMaskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.maskSize = `100% ${viewportHeight}px`;
    messageLayer.style.webkitMaskSize = `100% ${viewportHeight}px`;
  }, []);

  const syncTurnNavigatorViewport = useCallback(
    (element: HTMLDivElement) => {
      syncMessageLayerMask(element);
      // rail 常开后目录项常有，rect 读取不再有开关可停：但读取范围仍只限目录
      // rowId（turnNavigatorQueryRowIds），非目录行直接跳过，不做全量扫描。
      // 写 mask 后紧跟读 rect 会强制同步重排——mask 写入已在上一个语句完成，
      // 浏览器会把两者合并到同一次布局里；旧开关省掉的正是这一轮读取。
      const viewportRect = element.getBoundingClientRect();
      const queryPositions: ConversationTurnNavigatorQueryPosition[] = [];
      for (const rowElement of element.querySelectorAll<HTMLElement>("[data-row-id]")) {
        const rowId = Number(rowElement.dataset.rowId);
        if (!Number.isSafeInteger(rowId) || !turnNavigatorQueryRowIdsRef.current.has(rowId)) {
          continue;
        }
        const rowRect = rowElement.getBoundingClientRect();
        const start = element.scrollTop + rowRect.top - viewportRect.top;
        queryPositions.push({ rowId, start, end: start + rowRect.height });
      }
      const nextViewport = {
        scrollOffsetPx: element.scrollTop,
        viewportHeightPx: element.clientHeight,
        // turn 级 active 只能命中同 turn 的第一条 query。这里从已挂载
        // 的稳定 row anchor 推导当前 query；虚拟 turn 尚未挂载时组件再回退 unit。
        activeQueryRowId: resolveConversationTurnNavigatorActiveQueryRowId({
          positions: queryPositions,
          scrollOffsetPx: element.scrollTop,
          viewportHeightPx: element.clientHeight,
        }),
      };
      setTurnNavigatorViewport((current) =>
        current.scrollOffsetPx === nextViewport.scrollOffsetPx &&
        current.viewportHeightPx === nextViewport.viewportHeightPx &&
        current.activeQueryRowId === nextViewport.activeQueryRowId
          ? current
          : nextViewport,
      );
    },
    [syncMessageLayerMask],
  );

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const messageLayer = messageLayerRef.current;
    if (!scrollElement || !messageLayer) return;

    const sync = () => syncMessageLayerMask(scrollElement);
    sync();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(sync);
      observer.observe(scrollElement);
      observer.observe(messageLayer);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [syncMessageLayerMask, renderUnits.length === 0]);

  const buildCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const metrics = {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      };
      const wasPinnedToBottom = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics,
        lastObservedScrollTop: lastObservedScrollTopRef.current,
      });
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        wasPinnedToBottom,
        updatedAt: Date.now(),
      };
    },
    [],
  );

  const cacheCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const state = buildCurrentScrollMemoryState(element);
      if (scrollMemoryKey) {
        latestScrollMemoryStateRef.current = { key: scrollMemoryKey, state };
      }
      return state;
    },
    [buildCurrentScrollMemoryState, scrollMemoryKey],
  );

  const notifyScrollObserversAfterCommit = useCallback((element: HTMLDivElement) => {
    scheduleMicrotask(() => {
      if (scrollRef.current !== element) return;
      element.dispatchEvent(new Event("scroll"));
    });
  }, []);

  const captureScrollMemoryBeforeScopeMutation = useCallback(
    (previousKey: string | null): ConversationScrollMemoryScopeSnapshot | null => {
      const pendingRestore = pendingDetachedScrollRestoreRef.current;
      if (pendingRestore?.key === previousKey) {
        // 会话数据尚未到达时 DOM 只能读到被钳制的 scrollTop=0；此时切换
        // 任务不能用空时间线覆盖原记忆，必须保留尚未落地的 detached 恢复意图。
        return pendingRestore;
      }
      const element = scrollRef.current;
      if (!previousKey || !element) return null;
      return {
        key: previousKey,
        state: buildCurrentScrollMemoryState(element),
      };
    },
    [buildCurrentScrollMemoryState],
  );

  const commitCapturedScrollMemory = useCallback(
    (snapshot: ConversationScrollMemoryScopeSnapshot | null) => {
      if (!snapshot) return;
      latestScrollMemoryStateRef.current = snapshot;
      saveChatSessionScrollMemoryState(snapshot.key, snapshot.state);
    },
    [],
  );

  // 贴底必须 instant（scrollTop 赋值）：smooth 的中间帧会被 scroll 判定误读为「离底」。
  const scrollToBottom = useCallback(() => {
    // 折叠锚点窗口内，用户刚点开的块不允许被任何贴底入口（内容 commit、宽度 resize
    // 回调、会话内后续动作）重新吸底——那就是「一点展开整段飘走」的直接来源。
    if (shouldSuppressTimelineScrollToBottom(toggleAnchorRef.current !== null)) return;
    clearUserScrollAnchor();
    const element = scrollRef.current;
    if (!element) return;
    markProgrammaticScroll("bottom");
    // 草稿安全居中允许内容在低高度下向下溢出；若沿用真实会话吸底，
    // 顶部安全留白会被滚走。草稿始终展示顶部，真实会话继续吸底。
    element.scrollTop = responsiveCenteredEmptyLayout ? 0 : element.scrollHeight;
    // 回读取钳制后的落点入账（浏览器会把赋值钳到最大可滚动距离）。
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    userAdjustedScrollSinceRestoreRef.current = false;
    cacheCurrentScrollMemoryState(element);
    notifyScrollObserversAfterCommit(element);
  }, [
    cacheCurrentScrollMemoryState,
    clearUserScrollAnchor,
    responsiveCenteredEmptyLayout,
    markProgrammaticScroll,
    notifyScrollObserversAfterCommit,
    syncTurnNavigatorViewport,
  ]);

  /**
   * 把用户刚点的折叠触发器钉回原来的视口位置。
   *
   * 折叠动画期间高度逐帧变化，每次都走下面 applyContentAnchorAction；只要锚点在
   * 作用窗口内，就按偏移差抵消 scrollTop，而不是贴底。返回是否由锚点接管。
   */
  const compensateToggleAnchor = useCallback(
    (element: HTMLDivElement): boolean => {
      const anchor = toggleAnchorRef.current;
      if (!anchor) return false;
      const currentOffsetTop =
        anchor.element.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const adjustment = timelineToggleAnchorAdjustment(anchor.offsetTop, currentOffsetTop);
      if (adjustment === 0) return true;
      markLayoutScrollGuard();
      element.scrollTop += adjustment;
      // 程序化平移同样入账，避免被后续贴底对账误读为「未观察滚动」。
      lastObservedScrollTopRef.current = element.scrollTop;
      syncTurnNavigatorViewport(element);
      cacheCurrentScrollMemoryState(element);
      return true;
    },
    [cacheCurrentScrollMemoryState, markLayoutScrollGuard, syncTurnNavigatorViewport],
  );

  /**
   * 内容高度变化后的滚动动作。用户点击折叠组期间保持锚点（见 compensateToggleAnchor），
   * 其余情况沿用底部锚定：跟随中贴底，已解除则保持阅读位置。
   */
  const applyContentAnchorAction = useCallback(
    (following: boolean, contentWidthChanging = isContentWidthChanging()) => {
      const element = scrollRef.current;
      if (!element) return;
      const action = resolveTimelineContentAnchorAction({
        toggleAnchorActive: toggleAnchorRef.current !== null,
        following,
        contentWidthChanging,
      });
      if (action === "hold") {
        compensateToggleAnchor(element);
        return;
      }
      scrollToBottom();
    },
    [compensateToggleAnchor, isContentWidthChanging, scrollToBottom],
  );

  /**
   * 消费用户滚动期间的测量校正。virtualizer 已更新 measurement cache，但
   * shouldAdjustScrollPositionOnItemSizeChange 在用户滚动时返回了 false；这里用
   * 同一个稳定可见 turn 的 key 一次性恢复视觉偏移，避免逐条写回 scrollTop。
   */
  const consumeUserScrollAnchorCorrection = useCallback(() => {
    const element = scrollRef.current;
    const anchor = userScrollAnchorRef.current;
    if (!element || !pendingUserScrollAnchorCorrectionRef.current || anchor === null) {
      return {
        attempted: false,
        applied: false,
        adjustment: null,
        anchorCaptured: anchor !== null,
      };
    }

    const nextMeasurement = virtualizer.measurementsCache.find(
      (measurement) => measurement.key === anchor.key,
    );
    if (!nextMeasurement) {
      pendingUserScrollAnchorCorrectionRef.current = false;
      clearUserScrollAnchor();
      return {
        attempted: true,
        applied: false,
        adjustment: null,
        anchorCaptured: true,
      };
    }

    const scrollTopBefore = element.scrollTop;
    const adjustment = resolveTimelineUserScrollAnchorAdjustment({
      anchor,
      nextKey: nextMeasurement.key,
      nextStart: nextMeasurement.start,
      scrollTop: scrollTopBefore,
    });
    pendingUserScrollAnchorCorrectionRef.current = false;
    if (adjustment === null) {
      clearUserScrollAnchor();
      return {
        attempted: true,
        applied: false,
        adjustment: null,
        anchorCaptured: true,
      };
    }

    if (Math.abs(adjustment) >= USER_SCROLL_ANCHOR_EPSILON_PX) {
      markLayoutScrollGuard();
      element.scrollTop = scrollTopBefore + adjustment;
      const appliedAdjustment = element.scrollTop - scrollTopBefore;
      lastObservedScrollTopRef.current = element.scrollTop;
      syncTurnNavigatorViewport(element);
      cacheCurrentScrollMemoryState(element);
      notifyScrollObserversAfterCommit(element);
      const prependDebugContext = lastPrependDebugContextRef.current;
      const prependContext =
        prependDebugContext && prependDebugContext.expiresAt >= Date.now()
          ? prependDebugContext
          : null;
      if (prependDebugContext !== prependContext) {
        lastPrependDebugContextRef.current = null;
      }
      recordConversationTimelineDebugEvent("P5-user-anchor-write", {
        runId: TIMELINE_SCROLL_DEBUG_RUN_ID,
        requestId: prependContext?.requestId ?? null,
        prependContextPresent: prependContext !== null,
        scrollTopBefore,
        scrollTopAfter: element.scrollTop,
        computedAdjustment: adjustment,
        appliedAdjustment,
        prependAdjustment: prependContext?.adjustment ?? null,
        prependScrollTopAfter: prependContext?.scrollTopAfter ?? null,
        pendingUserCorrection: pendingUserScrollAnchorCorrectionRef.current,
      });
      // 保留最近一次 P4 上下文，供紧随其后的 P6 关联；它会在 TTL 到期时惰性清理。
      if (!hasActiveUserScrollInteraction()) {
        clearUserScrollAnchor();
      }
      return {
        attempted: true,
        applied: appliedAdjustment !== 0,
        adjustment: appliedAdjustment,
        anchorCaptured: true,
      };
    }

    if (!hasActiveUserScrollInteraction()) {
      clearUserScrollAnchor();
    }
    return {
      attempted: true,
      applied: false,
      adjustment: 0,
      anchorCaptured: true,
    };
  }, [
    cacheCurrentScrollMemoryState,
    clearUserScrollAnchor,
    hasActiveUserScrollInteraction,
    markLayoutScrollGuard,
    notifyScrollObserversAfterCommit,
    syncTurnNavigatorViewport,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const contentColumn = virtualHistoryRef.current;
    if (!contentColumn || typeof ResizeObserver === "undefined") return;

    stableContentWidthRef.current = contentColumn.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = contentColumn.clientWidth;
      if (nextWidth === stableContentWidthRef.current) return;

      // 宽度变化会让虚拟行分批重新测高；逐行补偿或逐批追底都会
      // 连续改写 scrollTop。resize 期间暂停两者，稳定后只执行一次最终贴底。
      contentWidthResizeActiveRef.current = true;
      clearUserScrollAnchor();
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
      }
      contentWidthResizeSettleTimerRef.current = window.setTimeout(() => {
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        contentWidthResizeSettleTimerRef.current = null;
        if (followingRef.current) {
          scrollToBottom();
        }
      }, CONTENT_WIDTH_RESIZE_SETTLE_MS);
    });
    observer.observe(contentColumn);

    return () => {
      observer.disconnect();
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
        contentWidthResizeSettleTimerRef.current = null;
      }
      contentWidthResizeActiveRef.current = false;
    };
  }, [clearUserScrollAnchor, renderUnits.length === 0, scrollToBottom]);

  useLayoutEffect(() => {
    const element = liveTailRef.current;
    const cacheKey = getUnitHeightCacheKey(liveUnit ?? undefined);
    if (!element || cacheKey === undefined) return;

    const cacheHeight = (entry?: ResizeObserverEntry) => {
      const height = measureRowHeight(element, entry);
      heightCacheRef.current?.set(cacheKey, height);
      return height;
    };
    let observedHeight = cacheHeight();
    if (typeof ResizeObserver === "undefined") return;

    // projection revision 的父 layout effect 可能早于 Markdown 子树最终测高；
    // 旧 observer 只缓存高度，正文会先把 loading 槽顶下去，后续 commit 才补 scrollTop。
    // ResizeObserver 在绘制前拿到真实高度，这里仅在仍拥有 following 滚动权时同步吸底；
    // 用户已经上滚（包括 scroll event 尚未入账的竞态）则只缓存，不夺回阅读位置。
    const observer = new ResizeObserver((entries) => {
      const nextHeight = cacheHeight(entries[0]);
      if (nextHeight === observedHeight) return;
      const previousHeight = observedHeight;
      observedHeight = nextHeight;

      const scrollElement = scrollRef.current;
      if (!scrollElement) return;
      const scrollTopBefore = scrollElement.scrollTop;
      markLayoutScrollGuard();
      const followingBefore = followingRef.current;
      const contentWidthChanging = isContentWidthChanging();
      const following = reconcileFollowingForContentAnchor({
        following: followingBefore,
        metrics: {
          scrollTop: scrollElement.scrollTop,
          viewportHeight: scrollElement.clientHeight,
          contentHeight: scrollElement.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
      applyContentAnchorAction(following, contentWidthChanging);
      recordConversationTimelineDebugEvent("A6-live-tail", {
        previousHeight,
        nextHeight,
        heightDelta: nextHeight - previousHeight,
        followingBefore,
        followingAfter: followingRef.current,
        contentWidthChanging,
        scrollTopBefore,
        scrollTopAfter: scrollElement.scrollTop,
        contentHeight: scrollElement.scrollHeight,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    applyContentAnchorAction,
    commitFollowing,
    getActiveUserScrollIntent,
    isContentWidthChanging,
    liveUnit?.key,
    markLayoutScrollGuard,
  ]);

  const saveCurrentScrollMemory = useCallback(() => {
    const key = scrollMemoryKey;
    const element = scrollRef.current;
    if (!key) return;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const cached = latestScrollMemoryStateRef.current;
    const cachedState = cached?.key === key ? cached.state : null;
    const state =
      pendingRestore?.key === key
        ? pendingRestore.state
        : element
          ? cacheCurrentScrollMemoryState(element)
          : cachedState;
    if (state) saveChatSessionScrollMemoryState(key, state);
  }, [cacheCurrentScrollMemoryState, scrollMemoryKey]);

  const restoreScrollMemory = useCallback(
    (state: ChatSessionScrollMemoryState) => {
      const element = scrollRef.current;
      if (!element) return;
      clearUserScrollIntent();
      markProgrammaticScroll("restore");
      const requestedScrollTop = state.scrollTop;
      const resolvedScrollTop = resolveChatSessionScrollRestoreTop(state, element);
      const contentHeightBefore = element.scrollHeight;
      element.scrollTop = resolvedScrollTop;
      const actualScrollTop = element.scrollTop;
      lastObservedScrollTopRef.current = actualScrollTop;
      followingRef.current = false;
      setBackToBottomVisible(shouldShowBackToBottom(false, unitsRef.current.length));
      syncTurnNavigatorViewport(element);
      userAdjustedScrollSinceRestoreRef.current = false;
      cacheCurrentScrollMemoryState(element);
      const resolverClamped =
        Math.abs(resolvedScrollTop - requestedScrollTop) > SCROLL_MEMORY_RESTORE_TOLERANCE_PX;
      const browserClamped =
        Math.abs(actualScrollTop - resolvedScrollTop) > SCROLL_MEMORY_RESTORE_TOLERANCE_PX;
      recordConversationTimelineDebugEvent("A7-restore", {
        requestedScrollTop,
        resolvedScrollTop,
        actualScrollTop,
        resolverClamped,
        browserClamped,
        clamped: resolverClamped || browserClamped,
        contentHeightBefore,
        contentHeightAfter: element.scrollHeight,
        viewportHeight: element.clientHeight,
        rowCount: unitsRef.current.length,
      });
    },
    [
      cacheCurrentScrollMemoryState,
      clearUserScrollIntent,
      markProgrammaticScroll,
      syncTurnNavigatorViewport,
    ],
  );

  /**
   * 历史预取触发：接近顶部（离顶两个视口）时调 onLoadOlder 取一页更早行。
   *
   * 声明在 handleScroll 之前是刻意的：handleScroll 的依赖数组引用了它，
   * 定义在后会在渲染时触发 TDZ。调用方有两个：handleScroll（scroll 事件）
   * 与下方的消息层 ResizeObserver effect（高度变化）——折叠后不足一屏的
   * 内容永远产生不了 scroll 事件，scroll 路径在那类会话里是哑的。
   *
   * 防环不需要额外状态：取数在途或缓冲未提交时 store 单飞 no-op，
   * `loadingOlder` 期间重复调用无效果，取数失败的冷却仍走 store 的
   * `loadOlderRetryAfterMs`。
   */
  const maybePrefetchOlder = useCallback(
    (element: HTMLDivElement, source: "scroll" | "resize") => {
      // 只在 64px 顶边才补页时，用户会先撞到窗口边界再看到内容跳入；提前两个
      // 视口预取，让桌面和手机 Web 共用的 renderer 在用户抵达边界前完成补页。
      const loadOlder = loadOlderRef.current;
      const triggerPx = historyPrefetchTriggerPx(element.clientHeight);
      if (
        !shouldTriggerLoadOlder({
          scrollTop: element.scrollTop,
          canLoadOlder: loadOlder.canLoadOlder,
          loadingOlder: loadOlder.loadingOlder,
          triggerPx,
        })
      ) {
        return;
      }
      // 顶部前插走块装载，不再消费用户测高校正锚点，先解除其所有权。
      clearUserScrollAnchor();
      const debugRequestId = ++timelineDebugRequestIdRef.current;
      clearPendingPrependDebugTimer();
      pendingPrependDebugRequestIdRef.current = debugRequestId;
      pendingPrependDebugLoadingObservedRef.current = null;
      lastPrependDebugContextRef.current = null;

      recordConversationTimelineDebugEvent("P2-load-start", {
        runId: TIMELINE_SCROLL_DEBUG_RUN_ID,
        requestId: debugRequestId,
        scrollTop: element.scrollTop,
        triggerPx,
        canLoadOlder: loadOlder.canLoadOlder,
        loadingOlder: loadOlder.loadingOlder,
        handlerPresent: Boolean(loadOlder.onLoadOlder),
        source,
      });
      logger.debug("[v4-timeline] 接近历史窗口顶部，自动预取更早行", {
        scrollTop: element.scrollTop,
        triggerPx,
        source,
      });
      const loadResult = loadOlder.onLoadOlder?.();
      if (loadResult) {
        void loadResult.then(
          () => schedulePendingPrependDebugCleanup(debugRequestId),
          () => schedulePendingPrependDebugCleanup(debugRequestId),
        );
      } else {
        // lease 缺失或同步 no-op 时没有 loadingOlder 状态可等待，下一帧清理未启动的探针请求。
        schedulePendingPrependDebugCleanup(debugRequestId);
      }
    },
    [
      clearPendingPrependDebugTimer,
      clearUserScrollAnchor,
      schedulePendingPrependDebugCleanup,
    ],
  );

  /**
   * 向下预取触发：中部窗口未连尾部时，接近底部（离底两个视口）调 onLoadNewer
   * 向后取一页。与 maybePrefetchOlder 对称——触发阈值同款（两个视口），防环同样
   * 不需要额外状态：连尾部后 canLoadNewer 即 false，取数在途 store 单飞 no-op。
   */
  const maybePrefetchNewer = useCallback(
    (element: HTMLDivElement) => {
      const loadNewer = loadNewerRef.current;
      if (!loadNewer.canLoadNewer || !loadNewer.onLoadNewer) return;
      const triggerPx = historyPrefetchTriggerPx(element.clientHeight);
      const distanceFromBottom =
        element.scrollHeight - element.clientHeight - element.scrollTop;
      if (distanceFromBottom > triggerPx) return;
      logger.debug("[v4-timeline] 接近中部窗口底部，自动向后补页", {
        distanceFromBottom,
        triggerPx,
      });
      void loadNewer.onLoadNewer();
    },
    [],
  );

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const activeUserScrollIntent = getActiveUserScrollIntent();
    // 折叠锚点窗口内的 scroll 事件：焦点 scroll-into-view、virtualizer 晚到的修正
    // 都会把刚点的行推走。只要不是用户主动滚轮/拖拽，一律按「点哪留哪」写回。
    // 用户真的滚动离开则立即释放锚点，把滚动权交还给用户。
    if (
      toggleAnchorRef.current !== null &&
      activeUserScrollIntent === "awayFromBottom" &&
      !(touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null)
    ) {
      clearToggleAnchor();
    }
    if (
      shouldCompensateTimelineToggleAnchorOnScroll({
        toggleAnchorActive: toggleAnchorRef.current !== null,
        userScrollIntent: activeUserScrollIntent,
        pointerScrollInteractionActive:
          touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null,
      })
    ) {
      compensateToggleAnchor(element);
    }
    const programmaticScroll =
      programmaticScrollFrameRef.current !== null &&
      Math.abs(element.scrollTop - lastObservedScrollTopRef.current) < 1;
    const userScrollIntent = getActiveUserScrollIntent();
    // 用户输入优先；其余 scroll 若落在内容/测高 guard 内视为布局补偿，guard 外的
    // 未分类事件继续按真实用户滚动处理，兼容原生滚动条和辅助技术。
    const scrollSource =
      userScrollIntent !== "none"
        ? "user"
        : programmaticScroll
          ? "programmatic"
          : Date.now() <= layoutScrollGuardUntilRef.current
            ? "layout"
            : "user";
    // virtualizer 的原生 offset observer 会先于 React onScroll 入账；到这里即可确认它
    // 已看见恢复后的真实 scrollTop。用户滚动也应立即结束保护窗，把滚动权交还用户。
    if (scrollSource !== "layout") {
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    }
    const scrollTop = element.scrollTop;
    const observedScrollTopBefore = lastObservedScrollTopRef.current;
    const debugRequestId = pendingPrependDebugRequestIdRef.current;
    const hasUserScrollSignal =
      userScrollIntent !== "none" ||
      touchClientYRef.current !== null ||
      scrollbarPointerIdRef.current !== null;
    lastObservedScrollTopRef.current = scrollTop;
    if (scrollSource === "user") {
      // 位置一并喂进去：闸门要求「停在顶部」，而 scrollTop 只可能在 scroll 事件里变，
      // 所以最后一次事件读到的位置就是真实位置，不需要另找数据源。
      prependCommitGateRef.current?.noteScroll(scrollTop);
      // 锁的开关跟着位置走，不跟着 loadingOlder 走。预取在离顶两个视口就发出，
      // 若锁跟着 loadingOlder 落下，用户会在半路被冻住、再也到不了顶，闸门的顶部条件
      // 恒假、提交永不发生，锁也就永不释放。到达顶部才冻，才是「用户看到占位块」那一刻。
      if (hasPendingOlder) setPrependReachedTop(isTimelineAtTop(scrollTop));
      refreshUserScrollAnchor();
    }
    syncTurnNavigatorViewport(element);
    const viewportHeight = element.clientHeight;
    const contentHeight = element.scrollHeight;
    const distanceFromBottom = contentHeight - viewportHeight - scrollTop;
    const followingBefore = followingRef.current;
    const following = resolveFollowingAfterScroll({
      following: followingBefore,
      source: scrollSource,
      metrics: {
        scrollTop,
        viewportHeight,
        contentHeight,
      },
    });
    commitFollowing(following);
    if (debugRequestId !== null) {
      recordConversationTimelineDebugEvent("P1-scroll-pending", {
        runId: TIMELINE_SCROLL_DEBUG_RUN_ID,
        requestId: debugRequestId,
        source: scrollSource,
        userScrollIntent,
        hasUserScrollSignal,
        scrollTopBefore: observedScrollTopBefore,
        scrollTop,
        followingBefore,
        followingAfter: following,
        layoutGuardActive: Date.now() <= layoutScrollGuardUntilRef.current,
      });
    }
    recordConversationTimelineDebugEvent("A5-scroll", {
      source: scrollSource,
      userScrollIntent,
      followingBefore,
      followingAfter: following,
      scrollTop,
      viewportHeight,
      contentHeight,
      distanceFromBottom,
      layoutGuardActive: Date.now() <= layoutScrollGuardUntilRef.current,
      toggleAnchorActive: toggleAnchorRef.current !== null,
      pointerScrollInteractionActive:
        touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null,
    });
    if (scrollSource === "user") {
      pendingDetachedScrollRestoreRef.current = null;
      userAdjustedScrollSinceRestoreRef.current = true;
      saveCurrentScrollMemory();
    }
    maybePrefetchOlder(element, "scroll");
    maybePrefetchNewer(element);
  }, [
    clearToggleAnchor,
    clearUserScrollAnchor,
    commitFollowing,
    compensateToggleAnchor,
    getActiveUserScrollIntent,
    maybePrefetchNewer,
    maybePrefetchOlder,
    refreshUserScrollAnchor,
    saveCurrentScrollMemory,
    syncTurnNavigatorViewport,
    virtualizer,
  ]);

  // 消息层高度观察：折叠/展开、测高收缩、占位块与前插块显隐都会改变消息层高度，
  // 而折叠后不足一屏的内容永远产生不了 scroll 事件，handleScroll 的预取评估在
  // 那类会话里是哑的。这里用同一套 maybePrefetchOlder 补评估一次。
  //
  // 观察目标是 messageLayer 而不是 scroll 容器：消息层内含占位块、前插块与
  // style={{height: totalSize}} 的 virtualHistory，全部内容几何变化都落在这里，
  // 而滚动容器自身高度只随窗口变化。初次 observe 即回调一次，正好覆盖
  // 「打开即矮内容」的场景。防环不需要额外状态，见 maybePrefetchOlder 注释。
  useEffect(() => {
    const messageLayer = messageLayerRef.current;
    const scrollElement = scrollRef.current;
    if (!messageLayer || !scrollElement) return;
    const evaluate = () => {
      const element = scrollRef.current;
      if (element) maybePrefetchOlder(element, "resize");
    };
    evaluate();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(evaluate);
    observer.observe(messageLayer);
    return () => observer.disconnect();
  }, [maybePrefetchOlder]);

  const handleBackToBottom = useCallback(() => {
    pendingDetachedScrollRestoreRef.current = null;
    clearUserScrollIntent();
    commitFollowing(true);
    scrollToBottom();
    // scrollToBottom 只更新组件内 ref；若用户点击后立刻切任务，scope
    // cleanup/scroll 事件可能还没运行，旧 Map 会把下次恢复重新带回中部甚至顶部。
    saveCurrentScrollMemory();
  }, [clearUserScrollIntent, commitFollowing, saveCurrentScrollMemory, scrollToBottom]);

  // 中部窗口回到最新：整替换回尾窗并贴底。为什么不复用 handleBackToBottom：
  // 中部窗口未连尾部时新行进不了窗口，本地 scrollToBottom 只能滚到中部窗口的底，
  // 回不到真正的最新；必须先让 store 把尾窗取回来（windowEpoch+1 整替换），再贴底。
  // 换窗后窗口内容整体替换，滚动记忆按旧窗口存的 scrollTop 已无意义，这里不写记忆——
  // 下一次滚动事件会按新窗口重建。
  const handleBackToLatest = useCallback(() => {
    pendingDetachedScrollRestoreRef.current = null;
    clearUserScrollIntent();
    commitFollowing(true);
    void Promise.resolve(onLoadTailWindow?.()).then(() => {
      scrollToBottom();
    });
  }, [clearUserScrollIntent, commitFollowing, onLoadTailWindow, scrollToBottom]);

  useLayoutEffect(() => {
    if (!scrollToBottomActionRef) return;
    scrollToBottomActionRef.current = handleBackToBottom;
    return () => {
      // 只清理本实例登记的动作，避免切 pane 时旧 cleanup 覆盖新 timeline。
      if (scrollToBottomActionRef.current === handleBackToBottom) {
        scrollToBottomActionRef.current = null;
      }
    };
  }, [handleBackToBottom, scrollToBottomActionRef]);

  /**
   * 某轮的顶栏避让补偿：跳转落点按「轮 section 顶边对齐容器顶边」算，轮顶 padding 已经
   * 把首行往下推了一段，这里只补剩下的 `56 − padding`。
   *
   * unitIndex 是 renderUnits 空间；live tail 被 split 出去时 `virtualizedUnits` 只是少了
   * 末位一项，前面的下标与 renderUnits 逐一对应，live tail 那一条由 scrollToUnit 的
   * liveUnitIndex 分支单独处理（它落在时间线底部，与顶栏无关）。
   */
  const resolveUnitOcclusionOffsetPx = useCallback(
    (unitIndex: number): number => {
      const unit = renderUnits[unitIndex];
      if (!unit) return 0;
      return resolveJumpOcclusionOffsetPx({
        startsTimeline: unit.startsTimeline,
        startsWithWorkflowNotificationCard: turnStartsWithWorkflowNotificationCard(unit.header),
      });
    },
    [renderUnits],
  );

  /**
   * 跳转目标落在已提交的前插块里时走 DOM 定位：块常驻挂载、不参与虚拟化，
   * virtualizer 的 scrollToIndex 根本够不到它。返回 false 表示目标不在块内或
   * 节点未挂载，调用方回退到 virtualizer 路径。
   */
  const scrollToCommittedBlockUnit = useCallback(
    (unitIndex: number, behavior: ScrollBehavior): boolean => {
      if (unitIndex < 0 || unitIndex >= committedPrependUnits.length) return false;
      const element = scrollRef.current;
      const unit = renderUnits[unitIndex];
      const node = unit
        ? prependBlocksRef.current?.querySelector<HTMLElement>(`[data-turn-id="${unit.turnId}"]`)
        : null;
      if (!element || !node) return false;
      const targetTop =
        element.scrollTop +
        node.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        resolveUnitOcclusionOffsetPx(unitIndex);
      if (behavior === "auto") {
        element.scrollTop = targetTop;
      } else {
        element.scrollTo({ top: targetTop, behavior });
      }
      lastObservedScrollTopRef.current = element.scrollTop;
      syncTurnNavigatorViewport(element);
      return true;
    },
    [
      committedPrependUnits.length,
      renderUnits,
      resolveUnitOcclusionOffsetPx,
      syncTurnNavigatorViewport,
    ],
  );

  const scrollToQuery = useCallback(
    (
      target: { unitIndex?: number; rowId: number; turnId?: string },
      behavior: ScrollBehavior = "auto",
    ) => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }
      markProgrammaticScroll("query");

      // unitIndex 是旧 rail 的 renderUnits 下标（分享面板仍在用）；目录 rail 传 turnId。
      // 未挂载时按 turn 容器定位：先查已知的 unit 下标，查不到再按 turnId 在当前
      // 窗口里现找——找不到（目标不在本窗口）就直接等换窗后的 rAF 对齐。
      const resolveUnitIndex = (): number | undefined => {
        if (target.unitIndex !== undefined) return target.unitIndex;
        if (target.turnId === undefined) return undefined;
        const known = unitsRef.current.findIndex((unit) => unit.turnId === target.turnId);
        return known === -1 ? undefined : known;
      };

      const scrollMountedQuery = (element: HTMLDivElement): boolean => {
        const rowElement = element.querySelector<HTMLElement>(`[data-row-id="${target.rowId}"]`);
        if (!rowElement) return false;
        // 落点扣掉桌面顶栏高度：顶栏是覆盖层，query 行此前直接贴在容器顶边会被盖住。
        // 这里对齐的是行本身而不是轮顶，所以要补满 56px（轮顶 padding 不在这一段里）；
        // 轮目录未挂载时走的 scrollToIndex 兜底只是把轮挂出来，最终仍落回本函数，
        // 补偿只在这一处发生，不叠加。
        const targetTop =
          element.scrollTop +
          rowElement.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          TIMELINE_TOP_OCCLUSION_PX;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        logger.debug("[v4-turn-navigator] 定位用户 query", {
          behavior,
          rowId: target.rowId,
          unitIndex: resolveUnitIndex(),
        });
        return true;
      };

      const element = scrollRef.current;
      if (!element || scrollMountedQuery(element)) return;

      // product turn 是虚拟列表的最小挂载单元，steer query 是单元内锚点。目标未挂载时
      // 先无动画挂载所属 turn，再按用户 motion 偏好精确滚到 row，不能退回 turn 开头。
      const unitIndex = resolveUnitIndex();
      if (unitIndex === undefined) {
        // 目标 turn 不在本窗口：换窗由 onJumpToDirectoryEntry 负责，本函数只做已挂载
        // 定位；rAF 对齐循环等换窗后的窗口到达再落点。
      } else if (unitIndex === liveUnitIndex) {
        const liveTail = liveTailRef.current;
        if (liveTail) {
          element.scrollTop =
            element.scrollTop +
            liveTail.getBoundingClientRect().top -
            element.getBoundingClientRect().top;
        }
      } else if (scrollToCommittedBlockUnit(unitIndex, "auto")) {
        // 块内轮常驻挂载：轮节点已在，剩下的交给 rAF 对齐循环按 row 精确落点。
      } else {
        // virtualizer 只吃去掉 committed 前缀的余部，索引换回余部空间。
        virtualizer.scrollToIndex(unitIndex - committedPrependUnits.length, {
          align: "start",
          behavior: "auto",
        });
      }

      let remainingAttempts = 12;
      const alignMountedQuery = () => {
        turnNavigatorJumpFrameRef.current = null;
        const currentElement = scrollRef.current;
        if (currentElement && scrollMountedQuery(currentElement)) return;
        remainingAttempts -= 1;
        if (remainingAttempts <= 0) {
          logger.warn("[v4-turn-navigator] query 锚点挂载超时", {
            rowId: target.rowId,
            unitIndex: resolveUnitIndex(),
          });
          return;
        }
        turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
      };
      turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
    },
    [
      clearUserScrollIntent,
      commitFollowing,
      committedPrependUnits.length,
      liveUnitIndex,
      markProgrammaticScroll,
      scrollToCommittedBlockUnit,
      syncTurnNavigatorViewport,
      virtualizer,
    ],
  );

  useLayoutEffect(() => {
    if (!scrollToQueryActionRef) return;
    const action = (target: { unitIndex?: number; rowId: number; turnId?: string }) => {
      scrollToQuery(target);
    };
    scrollToQueryActionRef.current = action;
    return () => {
      if (scrollToQueryActionRef.current === action) {
        scrollToQueryActionRef.current = null;
      }
    };
  }, [scrollToQuery, scrollToQueryActionRef]);

  useEffect(
    () => () => {
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }
    },
    [sessionKey],
  );

  const scrollToUnit = useCallback(
    (unitIndex: number, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      markProgrammaticScroll("unit");
      if (unitIndex === liveUnitIndex) {
        const element = scrollRef.current;
        const liveTail = liveTailRef.current;
        if (!element || !liveTail) return;
        const targetTop =
          element.scrollTop +
          liveTail.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        return;
      }
      // 块内轮不参与虚拟化，scrollToIndex 够不到；DOM 节点常驻，直接定位（含顶栏
      // 避让补偿，与下面 virtualizer 分支同一语义）。
      if (scrollToCommittedBlockUnit(unitIndex, behavior)) return;
      // scrollToIndex 的 ScrollToOptions 只有 align/behavior，不读 scroll-margin。
      // align:"start" 把轮 section 的顶边对齐滚动容器顶边，而桌面顶栏是覆盖层不是占位块，
      // 所以顶栏避让只能显式补：轮顶 padding 已经被 section 的 pt-* 渲染出来了，
      // 这里只需补剩下的那段（56 − 该轮 padding），和 live tail 分支同一个写法。
      // virtualizer 只虚拟化去掉 committed 前缀的余部，索引换回余部空间。
      virtualizer.scrollToIndex(unitIndex - committedPrependUnits.length, {
        align: "start",
        behavior: "auto",
      });
      const element = scrollRef.current;
      if (!element) return;
      const occlusionOffsetPx = resolveUnitOcclusionOffsetPx(unitIndex);
      if (occlusionOffsetPx <= 0) {
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        return;
      }
      const targetTop = element.scrollTop - occlusionOffsetPx;
      if (behavior === "auto") {
        element.scrollTop = targetTop;
      } else {
        element.scrollTo({ top: targetTop, behavior });
      }
      lastObservedScrollTopRef.current = element.scrollTop;
      syncTurnNavigatorViewport(element);
    },
    [
      clearUserScrollIntent,
      commitFollowing,
      committedPrependUnits.length,
      liveUnitIndex,
      markProgrammaticScroll,
      resolveUnitOcclusionOffsetPx,
      scrollToCommittedBlockUnit,
      syncTurnNavigatorViewport,
      virtualizer,
    ],
  );

  useConversationTimelineFind({
    rootRef: scrollRef,
    renderUnits,
    rows,
    mountedRowsKey,
    canLoadOlder,
    loadingOlder,
    onLoadOlder,
    sessionPhase,
    conversationFindQuery,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
    scrollToUnit,
  });

  const saveCurrentScrollMemoryRef = useRef(saveCurrentScrollMemory);
  saveCurrentScrollMemoryRef.current = saveCurrentScrollMemory;

  useLayoutEffect(() => {
    return () => {
      // 真正卸载时 DOM 尚在；scope 更新则由 before-mutation capture 读取旧 DOM。
      saveCurrentScrollMemoryRef.current();
    };
  }, []);

  const rowCount = renderUnits.length;
  const rowWindowKey = `${rows.length}:${rows[0]?.rowId ?? "none"}:${rows[rows.length - 1]?.rowId ?? "none"}`;
  const pendingGuideKey = pendingGuides.map((item) => item.queueItemId).join(":");

  // V4 迁移删除旧 ChatView 滚动 hook 后，sessionKey effect 仍固定滚到底部，
  // 导致残留的 renderer-local 记忆模块彻底断线。这里在清测高并重新 measure 后按 scope
  // 恢复；首个 layout 立即写入防闪动，下一帧再校正异步测高，但必须把滚动权让给用户。
  useLayoutEffect(() => {
    clearUserScrollIntent();
    heightCacheRef.current?.clear();
    // 跨帧投影缓存一并重置：frame 持有上一会话的行对象，留着既钉内存，
    // 也让 rowId 跨会话可重复这件事有机会被当成「同一个 turn」复用。
    previousUnitFrameRef.current = undefined;
    agentTitleMemoRef.current?.clear();
    // prepend 锚定基线一并重置：rowId 跨会话可重复，禁止拿旧会话首行比较。
    prependAnchorRef.current = { firstRowId: null, totalSize: 0 };
    clearPendingPrependDebugTimer();
    pendingPrependDebugRequestIdRef.current = null;
    pendingPrependDebugLoadingObservedRef.current = null;
    lastPrependDebugContextRef.current = null;
    // draft 默认吸底会留下旧 virtualizer.scrollOffset；在恢复写入派发 scroll 事件前，
    // 测高若继续按旧 offset 校正，会把刚恢复的历史位置重新推回 draft 的落点。
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    virtualizer.measure();
    userAdjustedScrollSinceRestoreRef.current = false;

    const restoredState = readChatSessionScrollMemoryState(scrollMemoryKey);
    const pendingRestoreWait = resolvePendingScrollMemoryRestoreWait(
      restoredState,
      scrollRef.current,
      unitsRef.current.length > 0,
    );
    pendingDetachedScrollRestoreRef.current =
      scrollMemoryKey && restoredState && pendingRestoreWait
        ? {
            key: scrollMemoryKey,
            rowWindowKey,
            state: restoredState,
            waitFor: pendingRestoreWait,
          }
        : null;
    const restore = () => {
      if (!restoredState || restoredState.wasPinnedToBottom === true) {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
        followingRef.current = initialFollowing();
        setBackToBottomVisible(false);
        scrollToBottom();
        return;
      }
      restoreScrollMemory(restoredState);
    };

    restore();
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (!userAdjustedScrollSinceRestoreRef.current) {
        restore();
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    clearPendingPrependDebugTimer,
    clearUserScrollIntent,
    restoreScrollMemory,
    scrollMemoryKey,
    scrollToBottom,
    sessionKey,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    if (rowCount === 0 || !pendingRestore || pendingRestore.key !== scrollMemoryKey) {
      return;
    }

    // session scope 往往先于 rows 订阅完成；只在 scope commit 和下一帧
    // 恢复会把历史 scrollTop 钳成 0。首批内容到达后重新落地，并再等一帧校正测高。
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    restoreScrollMemory(pendingRestore.state);
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (
        pendingDetachedScrollRestoreRef.current === pendingRestore &&
        !userAdjustedScrollSinceRestoreRef.current
      ) {
        restoreScrollMemory(pendingRestore.state);
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        if (
          pendingDetachedScrollRestoreRef.current === pendingRestore &&
          canReleasePendingScrollMemoryRestore(
            pendingRestore,
            scrollRef.current,
            rowCount,
            canLoadOlder || totalCount > rows.length,
            rowWindowKey,
          )
        ) {
          pendingDetachedScrollRestoreRef.current = null;
        }
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    canLoadOlder,
    restoreScrollMemory,
    rowCount,
    rowWindowKey,
    scrollMemoryKey,
    totalCount,
    totalSize,
  ]);

  // prepend 锚定：前插历史行时把 scrollTop 平移「前插撑高的那段」，正在读的内容不动。
  // 两条路径共用本效应：
  //   - 块提交（runPrependCommit 的 flushSync）：inset 账本同步结算到容器终值高度，
  //     前插增量取有符号 totalSize 差值（窗口首轮被块收编后为负）与 inset 实测增量
  //     合成一笔，正负相抵后正好是真增量。全量进块后不再有 trailing 行走估算。
  //   - loadAllOlder 换快照：只有 totalSize delta 可用，inset 结算沿用 topInsetPx state。
  // keyed anchor 已退役：块路径的 Δ 来自装载 DOM 的实测，不再需要锚点推算。
  // 本效应声明在会话切换效应之后，切换 commit 上先重置基线再对账，防跨会话 rowId 误判为前插。
  useLayoutEffect(() => {
    const prev = prependAnchorRef.current;
    const nextFirstRowId = rowsRef.current[0]?.rowId ?? null;
    const nextTotalSize = virtualizer.getTotalSize();
    const scrollTopBefore = scrollRef.current?.scrollTop ?? null;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const pendingRestoreOwnsAnchor = pendingRestore?.key === scrollMemoryKey;
    const didPrepend =
      prev.firstRowId !== null && nextFirstRowId !== null && nextFirstRowId < prev.firstRowId;
    const debugRequestId = pendingPrependDebugRequestIdRef.current;
    // 块提交在途：didPrepend 由 runPrependCommit 的 flushSync 渲染触发。inset 账本
    // 必须结算到「header + 占位项 + 块容器终值高度」——staged 翻入流内的真实高度
    // 只有此刻的 DOM 才知道，闭包里的 prependBlocksHeight state 还停在上一次 observer
    // 回报的旧值。layout effect 在 DOM 变更之后运行，这里读到的是提交后的终值。
    const blockCommit = blockCommitInFlightRef.current && didPrepend;
    const fallbackAdjustment = pendingRestoreOwnsAnchor
      ? null
      : prependScrollAdjustment({
          prevFirstRowId: prev.firstRowId,
          nextFirstRowId,
          prevTotalSize: prev.totalSize,
          nextTotalSize,
        });
    // 块提交时 totalSize 差值有符号（首轮被块收编后为负），与 inset 实测增量
    // 合成一笔正负相抵；null（恢复接管）归一成 0，让写分支继续以 inset 为主结算。
    let adjustment: number | null = fallbackAdjustment;
    let blockCommitInsetPx: number | null = null;
    if (blockCommit && !pendingRestoreOwnsAnchor && prependBlocksRef.current) {
      adjustment = fallbackAdjustment ?? 0;
      blockCommitInsetPx =
        headerSlotHeight +
        pendingHistorySlotHeight +
        prependBlocksRef.current.getBoundingClientRect().height;
    }
    if (didPrepend && debugRequestId !== null) {
      recordConversationTimelineDebugEvent("P3-prepend-before-write", {
        runId: TIMELINE_SCROLL_DEBUG_RUN_ID,
        requestId: debugRequestId,
        prevFirstRowId: prev.firstRowId,
        nextFirstRowId,
        prevTotalSize: prev.totalSize,
        nextTotalSize,
        scrollTopBefore,
        blockCommit,
        blockCommitInsetPx,
        fallbackAdjustment,
        pendingRestoreOwnsAnchor,
        pendingUserCorrection: pendingUserScrollAnchorCorrectionRef.current,
        userAnchorPresent: userScrollAnchorRef.current !== null,
      });
    }
    if (adjustment !== null && scrollRef.current) {
      const element = scrollRef.current;
      markLayoutScrollGuard();
      // 顶部实心块随提交一起变化（块提交时容器长高、占位块消失），它们占掉的高度
      // 必须从补偿里同步结清：账本记的是「已补偿到哪」，只补偿 totalSize 增量而不
      // 结算 inset，正文会在提交瞬间错位一个块高。
      //
      // 两项合成一笔写入：分两次写会在中间多出一个 scroll 落点，浏览器可能就此发一次
      // 事件、把半程坐标当成用户滚动基线。pending 窗口内列表锁死，这一笔也不会与手势并发。
      const insetAdjustment = settleTopInset(blockCommitInsetPx ?? topInsetPx);
      element.scrollTop += adjustment + insetAdjustment;
      // 程序化平移同样入账，避免被下方贴底对账误读为「未观察滚动」。
      lastObservedScrollTopRef.current = element.scrollTop;
      syncTurnNavigatorViewport(element);
      cacheCurrentScrollMemoryState(element);
      // 一次前插数千行时，measurement cache 与 scrollTop 会在同一 commit
      // 更新，Chromium 可能合并掉原生 scroll 通知，virtualizer 仍按旧 offset 挂载首屏，
      // 形成“滚动条在底部、正文却空白”。commit 后按最终落点补发只读通知；若同帧存在
      // 用户 wheel/pointer 意图，handleScroll 仍会优先识别为 user，不夺回滚动权。
      notifyScrollObserversAfterCommit(element);
    }
    // 没有 prepend 写入时**不能**在这里结清 inset 账本：账本记的是「已补偿到哪」，
    // 提前结清等于告诉后面的独立补偿 effect「这段差值已经补过了」，而它并没有被写入。
    // 占位块出现那一帧就走这条路径，结果是 scrollMargin 变了 +56 而 scrollTop 没动，
    // 正文整体被推下一个块的高度。账本只能由真正写入它的那一处结算。
    let prependUserAnchorReanchored = false;
    let prependUserAnchorCleared = false;
    if (didPrepend) {
      // 只要历史行真正前插，就结束本轮用户测高校正的所有权；即使没有可写的
      // adjustment（恢复接管或总高度无变化），旧 measurement 也不能在 prepend
      // 坐标系之外再次消费。
      pendingUserScrollAnchorCorrectionRef.current = false;
      if (adjustment !== null && hasActiveUserScrollInteraction()) {
        refreshUserScrollAnchor();
        prependUserAnchorReanchored = userScrollAnchorRef.current !== null;
      } else {
        clearUserScrollAnchor();
        prependUserAnchorCleared = true;
      }
    }
    if (didPrepend) {
      recordConversationTimelineDebugEvent("A3-prepend", {
        runId: TIMELINE_SCROLL_DEBUG_RUN_ID,
        requestId: debugRequestId,
        prevFirstRowId: prev.firstRowId,
        nextFirstRowId,
        prevTotalSize: prev.totalSize,
        nextTotalSize,
        blockCommit,
        prependAdjustmentApplied: didPrepend && adjustment !== null,
        prependAdjustmentSource: blockCommit
          ? "block-inset"
          : adjustment !== null
            ? "total-size"
            : null,
        prependUserAnchorReanchored,
        prependUserAnchorCleared,
        pendingRestoreOwnsAnchor,
        adjustment,
        scrollTopBefore,
        scrollTopAfter: scrollRef.current?.scrollTop ?? null,
        contentHeight: scrollRef.current?.scrollHeight ?? null,
      });
    }
    if (didPrepend && debugRequestId !== null) {
      const scrollTopAfter = scrollRef.current?.scrollTop ?? null;
      lastPrependDebugContextRef.current = {
        requestId: debugRequestId,
        scrollTopAfter,
        adjustment,
        expiresAt: Date.now() + PREPEND_DEBUG_CONTEXT_TTL_MS,
      };
      recordConversationTimelineDebugEvent("P4-prepend-after-write", {
        runId: TIMELINE_SCROLL_DEBUG_RUN_ID,
        requestId: debugRequestId,
        prevFirstRowId: prev.firstRowId,
        nextFirstRowId,
        adjustment,
        scrollTopBefore,
        scrollTopAfter,
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        adjustmentSource: blockCommit ? "block-inset" : adjustment !== null ? "total-size" : null,
        blockCommitInsetPx,
        userAnchorReanchored: prependUserAnchorReanchored,
        userAnchorCleared: prependUserAnchorCleared,
        pendingUserCorrection: pendingUserScrollAnchorCorrectionRef.current,
        contentHeight: scrollRef.current?.scrollHeight ?? null,
      });
      clearPendingPrependDebugTimer();
      pendingPrependDebugLoadingObservedRef.current = null;
      pendingPrependDebugRequestIdRef.current = null;
    }
    // 待恢复的离底记忆拥有当前 commit 的坐标系；不能让 prepend 把临时 clamp 值再次
    // 平移。恢复 effect 会在同一 commit 的下一帧按最终内容高度重放原始位置。
    prependAnchorRef.current = {
      firstRowId: nextFirstRowId,
      totalSize: nextTotalSize,
    };
  });

  // 顶部实心块高度的独立补偿：占位块出现或消失（没有 prepend 发生）时，把 scrollTop
  // 同步平移同样的距离，下方内容视觉不动。
  //
  // 声明在 prepend effect 之后是刻意的：账本 appliedTopInsetRef 由 prepend effect 结清，
  // 本 effect 随后看到「已结算」就什么都不做；反过来则会在同一次 commit 里应用两次。
  useLayoutEffect(() => {
    // 块提交帧让位：prepend effect 的块分支刚把账本结到「容器终值实测高度」，而本
    // effect 闭包里的 topInsetPx 还是 observer 回报前的旧 state——不等会立刻按差值
    // 回写一笔（-H），state 追上后再补一笔（+H），提交瞬间抖两下。账本已结清，等
    // prependBlocksHeight state 追上来时 previousInsetPx === topInsetPx 自然短路。
    if (blockCommitInFlightRef.current) return;
    // 记结算前的值：这个探针的全部意义就是看清这一段差值从哪来到哪去，
    // 记结算后的就只剩一个恒等式。
    const previousInsetPx = appliedTopInsetRef.current;
    if (previousInsetPx === topInsetPx) return;
    // 先确认写得进去，再结算账本。顺序反了会在 element 为 null 时把差值吞掉——
    // 账本说「已补偿」，scrollTop 却没动，占位块出现时正文就整体被推下一个块的高度。
    const element = scrollRef.current;
    if (!element) return;
    const adjustment = settleTopInset(topInsetPx);
    if (adjustment === 0) return;
    markLayoutScrollGuard();
    element.scrollTop += adjustment;
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    cacheCurrentScrollMemoryState(element);
    notifyScrollObserversAfterCommit(element);
    recordConversationTimelineDebugEvent("A8-top-inset", {
      runId: TIMELINE_SCROLL_DEBUG_RUN_ID,
      adjustment,
      // 记结算前的值：这个探针的全部意义就是看清这一段差值从哪来到哪去，
      // 记结算后的就只剩一个恒等式。
      previousTopInsetPx: previousInsetPx,
      topInsetPx,
      scrollTopAfter: element.scrollTop,
    });
  }, [cacheCurrentScrollMemoryState, markLayoutScrollGuard, topInsetPx]);

  // 底部锚定：内容变化（新行 / 流式 delta / 动态测高修正 → totalSize 变化）时，
  // 跟随中贴底，解除跟随保持阅读位置。useLayoutEffect 在绘制前完成贴底，避免闪动。
  // terminal 会同时迁移 live tail、自动折叠历史并
  // 触发 virtualizer 多阶段测高；这些 scrollTop 回退属于布局，必须保持 following。
  // 若同帧有用户向上滚动，capture handler 会先登记 awayFromBottom，本 effect 必须让位。
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const scrollTopBefore = element?.scrollTop ?? null;
    const userScrollAnchorCorrection = consumeUserScrollAnchorCorrection();
    const followingBefore = followingRef.current;
    const contentWidthChanging = isContentWidthChanging();
    const toggleAnchorActive = toggleAnchorRef.current !== null;
    markLayoutScrollGuard();
    if (element) {
      const following = reconcileFollowingForContentAnchor({
        following: followingBefore,
        metrics: {
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          contentHeight: element.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
    }
    const action = element
      ? resolveTimelineContentAnchorAction({
          toggleAnchorActive,
          following: followingRef.current,
          contentWidthChanging,
        })
      : null;
    if (!userScrollAnchorCorrection.applied) {
      applyContentAnchorAction(followingRef.current, contentWidthChanging);
    }
    recordConversationTimelineDebugEvent("A4-content-anchor", {
      followingBefore,
      followingAfter: followingRef.current,
      contentWidthChanging,
      toggleAnchorActive,
      action,
      userScrollAnchorCorrection,
      scrollTopBefore,
      scrollTopAfter: element?.scrollTop ?? null,
      contentHeight: element?.scrollHeight ?? null,
      totalSize,
    });
  }, [
    applyContentAnchorAction,
    commitFollowing,
    consumeUserScrollAnchorCorrection,
    getActiveUserScrollIntent,
    isContentWidthChanging,
    markLayoutScrollGuard,
    topInsetPx,
    pendingGuideKey,
    rowCount,
    rows,
    totalSize,
  ]);

  useLayoutEffect(() => {
    if (scrollRef.current) {
      syncTurnNavigatorViewport(scrollRef.current);
    }
  }, [pendingGuideKey, rowCount, syncTurnNavigatorViewport, totalSize]);

  // 行清空（如 editUserQuery 大范围 rewind）：重置为跟随并收起按钮，
  // 后续重新出现的行走上面的锚定 effect 贴底。
  useEffect(() => {
    if (rowCount === 0) {
      if (pendingDetachedScrollRestoreRef.current?.key === scrollMemoryKey) {
        return;
      }
      clearUserScrollAnchor();
      followingRef.current = initialFollowing();
      if (backToBottomVisible) {
        setBackToBottomVisible(false);
      }
    }
  }, [backToBottomVisible, clearUserScrollAnchor, rowCount, scrollMemoryKey]);

  useEffect(() => {
    return () => {
      if (programmaticScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
        programmaticScrollFrameRef.current = null;
      }
      if (toggleAnchorTimerRef.current !== null) {
        window.clearTimeout(toggleAnchorTimerRef.current);
        toggleAnchorTimerRef.current = null;
      }
    };
  }, []);

  // raw projection row 与按 turn 合并后的 render unit 不是同一计量单位；
  // 分开暴露才能让恢复/分页验证不再把可见 unit 误当成持久 row。
  return (
    <div ref={timelineRootRef} className="relative flex min-h-0 flex-1 flex-col">
      {selectionActions ? (
        <ConversationSelectionTooltip
          rootRef={scrollRef}
          rows={rows}
          sourceSessionId={sessionKey}
          enabled={selectionActions.enabled}
          sideActionDisabled={selectionActions.sideActionDisabled}
          onAddToCurrentTask={selectionActions.onAddToCurrentTask}
          onAskInSideChat={selectionActions.onAskInSideChat}
        />
      ) : null}
      <ConversationScrollMemoryScopeCapture
        scopeKey={scrollMemoryKey}
        capture={captureScrollMemoryBeforeScopeMutation}
        commit={commitCapturedScrollMemory}
      />
      {/* 分享选择流程无论面板展开还是收起，左 rail 都由分享面板或 reopen 按钮独占，
          必须隐藏对话轮导航，避免两个绝对定位控件互相覆盖。退出分享选择后自动恢复。
          rail 常开：目录走 query/directory 侧信道，不再为目录拉取整段历史。 */}
      {hideTurnNavigator ? null : (
        <ConversationTurnNavigator
          items={turnNavigatorItems}
          isHydratingDirectory={queryDirectoryLoading}
          scrollOffsetPx={virtualizer.scrollOffset ?? turnNavigatorViewport.scrollOffsetPx}
          viewportHeightPx={
            virtualizer.scrollRect?.height ?? turnNavigatorViewport.viewportHeightPx
          }
          virtualItems={turnNavigatorVirtualItems}
          activeQueryRowId={turnNavigatorViewport.activeQueryRowId}
          onJumpToQuery={(target, behavior) => {
            // 目录 rail 的跳转先走换窗（目标不在本窗口时一次 around 取回），
            // 已挂载时 scrollToQuery 直接定位；换窗由 SessionPane 经 store 完成，
            // 到达后 rAF 对齐循环按 rowId 精确落点。
            if (onJumpToDirectoryEntry) {
              void onJumpToDirectoryEntry(target);
              return;
            }
            scrollToQuery(target, behavior);
          }}
        />
      )}
      <div
        ref={scrollRef}
        data-testid={TID_V4_TIMELINE}
        data-v4-timeline-scroll="true"
        data-v4-timeline-scroll-locked={backgroundScrollLocked ? "true" : "false"}
        data-markdown-table-layout-root="true"
        data-row-count={rows.length}
        data-window-row-count={rows.length}
        data-render-unit-count={renderUnits.length}
        data-total-row-count={totalCount}
        data-following={backToBottomVisible ? "false" : "true"}
        data-loading-older={loadingOlder ? "true" : "false"}
        onKeyDownCapture={handleKeyDownCapture}
        onPointerCancelCapture={handlePointerEndCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerUpCapture={handlePointerEndCapture}
        onScroll={handleScroll}
        onTouchCancelCapture={handleTouchEndCapture}
        onTouchEndCapture={handleTouchEndCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onWheelCapture={handleWheelCapture}
        className={cn(
          // 原生滚动条按内容高度动态出现时会缩窄会话视口，导致消息与 composer
          // 横向跳动；稳定预留 gutter，让桌面与手机 Web 共用的滚动区宽度保持不变。
          // 只声明 overflow-y-auto 会让浏览器把横轴计算为 auto，宽内容会把
          // 整条 Conversation 撑出横向滚动；表格和代码块应由各自内部容器滚动。
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] [--markdown-table-layout-left-inset:16px] [--markdown-table-layout-right-inset:16px] max-md:[--markdown-table-layout-left-inset:8px] max-md:[--markdown-table-layout-right-inset:8px]",
          // 分享选择面板展开时改为 overflow-hidden：scrollTop 与 scrollbar-gutter 都保持不变，
          // 但原生滚动条、滚轮和键盘翻页都不再能移动背景，勾选目标不会漂走。
          backgroundScrollLocked && "!overflow-y-hidden",
          // 补页落窗口期间同样锁死：这一帧里前插测高与 scrollTop 补偿必须独占
          // 滚动权，否则补偿按用户手势竞态后的旧基线写入。手势在此之前已被静默
          // 检测挡在门外，这里只兜住落锁瞬间恰好起手的那一下。
          prependPendingLocked && "!overflow-y-hidden",
          // Conversation turn map 覆盖 timeline 左侧 48px；表格增强滚动如果仍按
          // 普通 16px 边距借位，会有 32px 落到 turn map 下方，必须把完整占用计入左边界。
          turnNavigatorQueryRowIds.size >= 2 &&
            "@min-[864px]/conversation:[--markdown-table-layout-left-inset:48px]",
        )}
      >
        <div
          className={cn(
            // 固定高度断点会在窗口跨过临界值时让问候语与 composer 整组跳动。
            // 顶部留白按视口高度伸缩，输入框的位置不再受下方推荐列表高度影响；
            // 空间不足时顶部可收缩到底线，底部继续随内容自然排布。
            responsiveCenteredEmptyLayout
              ? // 动态修改原生窗口下限会把内容换行反馈到窗口拖动，产生阻尼；
                // 容器保留固有最小高度，由外层 timeline 统一承接受限高度下的溢出内容。
                "flex min-h-full flex-col items-center px-4 before:block before:min-h-[52px] before:w-full before:shrink before:basis-[29dvh] before:content-[''] after:block after:min-h-4 after:w-full after:flex-1 after:content-['']"
              : centeredEmptyLayout
                ? "flex min-h-full flex-col items-center justify-center gap-4 px-4"
                : "flex min-h-full flex-col",
          )}
          // session 切到 draft 时内容高度骤降，Chrome 会把子树里的
          // sticky composer 选作原生 scroll anchor，并在切回后覆盖 layout/RAF 恢复值。
          // V4 已自管 prepend、吸底和记忆锚点；和其它虚拟列表一致，应从内容子树禁用锚点候选。
          style={{ overflowAnchor: "none" }}
        >
          {renderUnits.length === 0 && !headerSlot ? (
            <div
              className={cn(
                centeredEmptyLayout
                  ? "flex w-full max-w-2xl shrink-0 items-center justify-center"
                  : "min-h-0 flex-1",
                !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
              )}
            >
              {emptyState}
            </div>
          ) : (
            <div
              ref={messageLayerRef}
              data-v4-timeline-message-layer="true"
              className="relative w-full flex-1 [mask-repeat:no-repeat] [-webkit-mask-repeat:no-repeat]"
            >
              {/*
               * 补页占位块：列表里真实占高度的一个块，不是浮层。滚到顶时它完整可见，
               * 而 scrollTop 归零也意味着上方没有可去的地方——「看到占位块」与
               * 「列表已经滚不动」是同一件事，前插提交也就有了明确的位置条件。
               *
               * 与 headerSlot 同理必须落在被 mask 的消息层内、套用同样的宽度类，
               * 放在消息层之外会比正文宽、并从 sticky composer 下方透出来。
               */}
              {showHistoryLoading ? (
                <div
                  data-testid={TID_V4_TIMELINE_LOAD_OLDER}
                  data-v4-timeline-pending-history-slot="true"
                  data-v4-timeline-content-column="true"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className={timelineContentColumnClass({
                    base: "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  })}
                >
                  <div className="flex h-14 items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 text-xs text-muted-foreground">
                    <Spinner className="size-3.5" aria-hidden="true" />
                    <span className="truncate">
                      {intl.formatMessage({
                        id: "chat.history.loadingOlderMessages",
                      })}
                    </span>
                  </div>
                </div>
              ) : null}
              {/*
               * 前插块容器：staged 与 committed 是同一条扁平列表（staged 在前，代表
               * 更早的内容），key 为 turnId。提交时 staged 单元不出列表——同一 key 的
               * 位置上只有 wrapper 的 className/style 从「负偏移隐藏」翻成「流内」，
               * React 复用 DOM 节点，测量与装载是同一个元素，渲染只发生一次。
               *
               * staged 的负偏移方向是刻意的：height 受限的容器里向下溢出会进
               * scrollHeight、污染全部坐标；向上偏移在滚动区域之外，对 scrollTop
               * / scrollHeight 零影响。staged wrapper 仍参与布局（absolute 但非
               * hidden），所以量得到高度。
               *
               * 宽度类与真实列同源（timelineContentColumnClass）：宽度不同则文字
               * 换行不同，量出的高度就是错的——而装载用的正是这个高度。
               */}
              {blockUnitCount > 0 ? (
                <div
                  ref={prependBlocksRef}
                  data-v4-timeline-prepend-blocks="true"
                  className={timelineContentColumnClass({
                    base: "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  })}
                >
                  {[
                    ...stagedPrependUnits.map((unit) => ({ unit, staged: true })),
                    ...committedPrependUnits.map((unit) => ({ unit, staged: false })),
                  ].map(({ unit, staged }) => (
                    <div
                      key={unit.key}
                      data-v4-turn-unit="true"
                      data-turn-id={unit.turnId}
                      aria-hidden={staged || undefined}
                      className={
                        staged
                          ? timelineContentColumnClass({
                              // 与真实虚拟列逐字一致（含 @min-[1280px] 降级）：真实列在宽度
                              // 动画的 150ms 里宽度是渐变的，这里不带过渡就会跳到终值，
                              // 量出的是终态宽度下的高度，而真实列此刻还不是那么宽。
                              base: "absolute left-0 w-full transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                              contentWidthClassName,
                              summaryPanelInlineOffsetClassName,
                            })
                          : "w-full"
                      }
                      style={staged ? { top: -10000 } : undefined}
                    >
                      <ConversationTurnGroup
                        unit={unit}
                        apiRetry={null}
                        context={renderRowContext}
                        onFork={onFork}
                        onRetry={onRetry}
                        onFeedbackChange={onFeedbackChange}
                        onEdit={onEdit}
                        shareSelection={shareSelection}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              {/*
               * headerSlot 必须落在被 mask 的消息层内、并套用与实时消息列相同的宽度类：
               * 放在消息层之外会既比正文宽、又从 sticky composer 下方透出来。
               */}
              {headerSlot ? (
                <div
                  ref={headerSlotRef}
                  data-v4-timeline-header-slot="true"
                  data-v4-timeline-content-column="true"
                  className={timelineContentColumnClass({
                    base: "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  })}
                >
                  {headerSlot}
                </div>
              ) : null}
              <div
                ref={virtualHistoryRef}
                data-v4-timeline-virtual-history="true"
                data-v4-timeline-content-column="true"
                className={timelineContentColumnClass({
                  // 默认（< 1280px）过渡 width/max-width/transform，让 w-full ↔ max-w-4xl
                  // 的中等宽度切换平滑；≥1280px 触发的面板让位（max-w-6xl + 168px 左移）
                  // 用 @min-[1280px] 降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                  base: "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  summaryPanelInlineOffsetClassName,
                })}
                style={{ height: totalSize }}
              >
                {virtualRows.map((virtualRow) => {
                  const unit = virtualizedUnits[virtualRow.index];
                  if (!unit) return null;
                  return (
                    <div
                      key={`${virtualRow.key}:${rowContext.logEpoch ?? ""}`}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-v4-turn-unit="true"
                      data-turn-id={unit.turnId}
                      // virtual history 的子项通过 absolute 定位，父级 padding 不会缩小
                      // 它们的 containing block；正文响应式内边距必须落在 turn wrapper 自身。
                      className="absolute left-0 top-0 w-full"
                      style={{
                        transform: `translateY(${virtualRow.start - topInsetPx}px)`,
                      }}
                    >
                      <ConversationTurnGroup
                        unit={unit}
                        apiRetry={null}
                        context={renderRowContext}
                        onFork={onFork}
                        onRetry={onRetry}
                        onFeedbackChange={onFeedbackChange}
                        onEdit={onEdit}
                        shareSelection={shareSelection}
                      />
                    </div>
                  );
                })}
              </div>
              {liveUnit !== null && liveUnitIndex !== null ? (
                <div
                  key={`${liveUnit.key}:${rowContext.logEpoch ?? ""}`}
                  ref={liveTailRef}
                  data-index={liveUnitIndex}
                  data-v4-running-live-tail="true"
                  data-v4-turn-unit="true"
                  data-turn-id={liveUnit.turnId}
                  data-v4-timeline-content-column="true"
                  className={cn(
                    // ≥1280px 面板让位时降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                    "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationTurnGroup
                    unit={liveUnit}
                    apiRetry={apiRetry}
                    context={renderRowContext}
                    onFork={onFork}
                    onRetry={onRetry}
                    onFeedbackChange={onFeedbackChange}
                    onEdit={onEdit}
                    shareSelection={shareSelection}
                  />
                </div>
              ) : null}
              {pendingGuides.length > 0 ? (
                <div
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationPendingGuideList
                    context={renderRowContext}
                    items={pendingGuides}
                    turnId={
                      liveUnit?.turnId ??
                      rows.at(-1)?.productTurnId ??
                      rows.at(-1)?.turnId ??
                      "pending-guide"
                    }
                  />
                </div>
              ) : null}
            </div>
          )}
          {bottomDock ? (
            <div
              ref={composerDockRef}
              data-v4-composer-dock="true"
              className={cn(
                // sticky dock 是 z-20 的全宽透明层，过去会盖住 z-10 rail
                // 在 composer 左侧留白内的按钮。外壳不接事件，只让实际内容列恢复命中。
                "pointer-events-none z-20 flex w-full justify-center",
                responsiveCenteredEmptyLayout
                  ? "mt-3 shrink-0"
                  : centeredEmptyLayout
                    ? "shrink-0"
                    : "sticky bottom-0",
              )}
            >
              <div
                data-v4-composer-dock-content="true"
                className={cn(
                  // 同 virtual history/live tail，恢复宽度过渡避免硬跳。
                  // ≥1280px 面板让位时降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                  "pointer-events-auto relative z-10 w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  !centeredEmptyLayout && "px-4 pb-4",
                  !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
                )}
              >
                <div data-v4-back-to-bottom-anchor="composer-dock" className="relative">
                  {canLoadNewer ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid={TID_V4_TIMELINE_LOAD_NEWER}
                      onClick={() =>
                        runUserAction({
                          input: {
                            featureId: "conversation.navigation",
                            action: "jump_latest",
                            trigger: "button",
                          },
                          operation: handleBackToLatest,
                          completed: { resultSource: "local_commit" },
                          failureStage: "timeline_scroll",
                        })
                      }
                      className="pointer-events-auto absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 gap-1.5 whitespace-nowrap shadow-sm"
                    >
                      <ArrowDownToLine className="size-3.5" aria-hidden="true" />
                      {intl.formatMessage({ id: "chat.backToLatest" })}
                    </Button>
                  ) : backToBottomVisible ? (
                    <ConversationBackToBottomButton
                      // 分屏下 composer 属于滚动视口内的 sticky dock；按钮若挂在
                      // timeline 外层 absolute bottom，会相对整个 pane 落到 input 下方。
                      //
                      // 圆钮采用自己的居中定位；`pointer-events-auto` 保留：
                      // 它是"按钮点得动"唯一可断言的契约。
                      className="pointer-events-auto absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 shadow-sm"
                      label={intl.formatMessage({ id: "chat.scrollToBottom" })}
                      onClick={handleBackToBottom}
                    />
                  ) : null}
                  {bottomDock}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {canLoadNewer && !bottomDock ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid={TID_V4_TIMELINE_LOAD_NEWER}
          onClick={() =>
            runUserAction({
              input: {
                featureId: "conversation.navigation",
                action: "jump_latest",
                trigger: "button",
              },
              operation: handleBackToLatest,
              completed: { resultSource: "local_commit" },
              failureStage: "timeline_scroll",
            })
          }
          className="absolute bottom-3 left-1/2 z-30 -translate-x-1/2 gap-1.5 whitespace-nowrap shadow-sm"
        >
          <ArrowDownToLine className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "chat.backToLatest" })}
        </Button>
      ) : backToBottomVisible && !bottomDock ? (
        <ConversationBackToBottomButton
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          label={intl.formatMessage({ id: "chat.scrollToBottom" })}
          onClick={handleBackToBottom}
        />
      ) : null}
    </div>
  );
}

export const ConversationTimeline = memo(ConversationTimelineImpl);
