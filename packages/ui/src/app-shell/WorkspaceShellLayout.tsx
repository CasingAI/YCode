/* eslint-disable max-lines -- workspace shell 当前集中编排 sidebar、chat、terminal 和 browser pane 的布局联动，先保持单文件收口，避免为满足行数限制打散关键布局状态。*/
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { TID_APP_HEADER } from "@zcode/shared";
// 保活：workspace tab 真正关闭时，按 workspaceKey 回收 side pane terminal 的常驻 PTY/xterm。
// 对称下侧 Terminal.tsx 的 openWorkspaceKeys 回收。
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import {
  V4SplitPaneEntryProvider,
  type V4SplitPaneSessionTarget,
} from "@/v4/splitPaneEntryContext.js";
import {
  WorkflowRunOpenProvider,
  type WorkflowRunOpenTarget,
} from "@/v4/workflowRunOpenContext.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  canPlaceWorkbenchSessionInSplit,
  placeWorkbenchSessionInSplit,
  selectWorkbenchSession,
} from "@/v4/workbenchSessionPlacement.js";
import { usePaneSessionPersistence } from "@/v4/usePaneSessionPersistence.js";
import { requestV4ComposerDraftWorkspaceTransfer } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { ChatEmptyWorkspacePreviewMenu } from "@/ChatEmptyState.js";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { WorkspacePluginPreview } from "@/WorkspacePluginPreview.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useIsNarrowViewport } from "@/hooks/useIsNarrowViewport.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

import { AUTOMATIONS_TOAST_ANCHOR_ID, AutomationsSection } from "@/settings/AutomationsSection.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { SettingsPage } from "@/SettingsPage.js";
import { TaskFindDialog } from "@/quickpick/TaskFindDialog.js";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import { WorkspaceSidebar } from "@/WorkspaceSidebar.js";
import { FilesWorkbenchSurface } from "@/files-workbench/FilesWorkbenchSurface.js";
import { filesWorkspaceKey } from "@/files-workbench/filesEditorModel.js";
import { toFilesWorkspaceRef } from "@/files-workbench/filesExplorerWorkspace.js";
import { useFilesEditorStoreApi } from "@/files-workbench/FilesEditorStoreProvider.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import {
  findScreenshotSurfaceTabForRender,
  useBrowserScreenshotSurfaceRequest,
} from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import { shouldWrapAnimatedSidePanePanel } from "@/app-shell/animatedSidePanePanelModel.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { useWorkspaceSidebarSwipe } from "@/app-shell/useWorkspaceSidebarSwipe.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";

import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellResizeHandleInsetPx,
  resolveWorkspaceShellSplitPanelFrameClassName,
  resolveWorkspaceShellWindowChromeClass,
} from "@/app-shell/workspaceShellWindowChrome.js";
import {
  resolveWorkspaceContentMinWidthClassName,
  resolveWorkspaceContentIsolationClassName,
  resolveWorkspaceContentPaddingClassName,
  resolveWorkspaceShellFilesSurfaceClassName,
  resolveWorkspaceShellSettingsSurfaceClassName,
  resolveWorkspaceShellTasksKeepaliveClassName,
  resolveWorkspaceOverlayBackdropClassName,
  resolveWorkspaceSidePaneExpandedSize,
  resolveWorkspaceSidePaneWrapperClassName,
  resolveWorkspaceSidebarPanelPositionClassName,
  resolveWorkspaceSidebarPanelSurfaceClassName,
  resolveWorkspaceSidebarPanelWidthCssValue,
  resolveWorkspaceSidebarPresentation,
  shouldCollapseWorkspaceSidebarAfterNavigation,
  shouldHideDesktopTopOverlayForSidePaneDrawer,
  shouldRunConversationAutoCollapseForViewportResize,
  type WorkspaceSidebarPresentation,
  shouldRenderWorkspaceHeader as shouldRenderWorkspaceHeaderForMainView,
  shouldRenderWorkspaceSidePaneBackdrop,
  shouldRenderWorkspaceSidebarBackdrop,
  shouldRenderWorkspaceSidebarResizeHandle,
  shouldMoveWebNavigationActionsIntoViewHeader,
  shouldReserveWebNavigationActionsSlot,
  resolveWebNavigationActionsSlotClassName,
  WORKSPACE_SIDEBAR_BACKDROP_Z_CLASS,
  WORKSPACE_SIDE_PANE_BACKDROP_Z_CLASS,
} from "@/app-shell/workspaceShellResponsiveLayout.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { toast } from "@/components/ui/toast.js";
import { getGitDirtyFileCount } from "@/git-branch-switcher/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";
import { shouldOpenAssistantHtmlInBrowser } from "@/lib/assistantPreviewCards.js";
import { setWorkspaceSidebarResizeActive } from "@/lib/workspaceSidebarResizeState.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { MessageSessionCitationTarget } from "@/components/ai-elements/message.js";
import { resolveSessionCitationWorkspace } from "@/lib/sessionCitationWorkspace.js";
import { citationJumpText } from "@/command-center/aiSearchAnswerContent.js";
import { runWebNavigation } from "@/lib/webNavigationGuard.js";
import {
  addWorkspacePathOpenRequestListener,
  selectWorkspacePathFileService,
  shouldFallbackWorkspacePathToCodeViewer,
  type WorkspacePathOpenRequest,
} from "@/lib/workspacePathNavigation.js";
import {
  buildSelectionSideChatKey,
  requestSelectionSideChatOpen,
} from "@/lib/selectionSideChatRuntime.js";
import { getActiveSelectionSideChatTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  areWorkspaceFilePathsEqual,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import type { WorkspaceShellLayoutProps } from "@/app-shell/types.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO = 0.5;
const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "zcode:workspace-shell:sidebar-width-px";
const LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY =
  "react-resizable-panels:workspace-shell-layout:sidebar:content";
const WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX = 16;
const WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR = "--workspace-sidebar-panel-width";
const WORKSPACE_SIDEBAR_WIDTH_CSS_VAR = "--workspace-sidebar-width";
const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
// WorkspaceShellLayout 是 memo 组件，默认 []/{} 会在缺省调用时每次创建新引用；
// 入口缺省这些集合时复用常量，避免浅比较误判 props 变化。
const EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY: NonNullable<
  WorkspaceShellLayoutProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"]
> = {};
const EMPTY_REMOTE_WORKSPACE_SESSIONS: NonNullable<
  WorkspaceShellLayoutProps["remoteWorkspaceSessions"]
> = [];
const CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX = 360;
const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
// 性能修复：ResizablePanelGroup 收到深相等的新 panelIds 数组，
// 会跟随 chat streaming render 重算布局上下文；固定数组语义上不会随消息变化。
const WORKSPACE_BODY_PANEL_IDS = ["conversation-column", "browser"];
const WORKSPACE_CONVERSATION_PANEL_IDS = ["conversation", "terminal"];

type WorkspaceSidebarResizeSession = {
  containerWidthPx: number;
  pointerId: number;
  startWidthPx: number;
  startX: number;
};

function clampWorkspaceSidebarWidth(widthPx: number, containerWidthPx?: number) {
  const maxWidthPx =
    containerWidthPx && containerWidthPx > 0
      ? Math.max(
          WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
          containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO,
        )
      : Number.POSITIVE_INFINITY;

  return Math.round(Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, Math.min(widthPx, maxWidthPx)));
}

function readStoredWorkspaceSidebarWidthPx(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampWorkspaceSidebarWidth(parsed) : null;
  } catch {
    return null;
  }
}

function readLegacyWorkspaceSidebarWidthRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { sidebar?: unknown };
    const ratio = Number(parsed.sidebar);
    return Number.isFinite(ratio) && ratio > 0 ? ratio / 100 : null;
  } catch {
    return null;
  }
}

function persistWorkspaceSidebarWidthPx(widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(widthPx)));
  } catch {
    // ignore
  }
}

export const WorkspaceShellLayout = memo(function WorkspaceShellLayoutComponent({
  services,
  workspaceReadOnlyReason,
  workspaceMainView,
  shellPrimaryView,
  onShowTasks,
  onShowSettings,
  onShowFiles,
  pluginStoreOpenVersion,
  openAutomationId,
  openAutomationTab,
  onWorkspaceMainViewChange,
  webRoutePosition,
  onWebRoutePositionChange,
  onOpenAutomationConsumed,
  handleOpenAutomations,
  handleOpenPluginStore,
  handleManageInstalledPlugins,
  onConnectRemote,
  onSelectRemoteProject,
  onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  onLogout,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey = EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY,
  onCreateTask,
  onCreateConversationTask,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  onCreateScratchWorkspace,
  allowOpenWorkspace = true,
  allowRemoteWorkspace = true,
  remoteWorkspaceSessions = EMPTY_REMOTE_WORKSPACE_SESSIONS,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop = false,
  isMacDesktop,
  isWindowsDesktop,
  workspaceShellZCodeState,
  theme,
  isMacFullscreen,
  desktopWindowChromeState,
  macWindowControlsLeftPaddingPx,
  windowsWindowControlsRightPaddingPx = 136,
  updateReadyVersion,
  updateState,
  sidebarContainerRef,
  toggleSidebarShortcutLabel,
  newTaskShortcutLabel,
  goBackShortcutLabel,
  goForwardShortcutLabel,
  toggleSidePaneShortcutLabel,
  canGoBack,
  canGoForward,
  canTaskNavBack,
  canTaskNavForward,
  isTerminalOpen,
  isSidebarVisible,
  isSidePaneOpen,
  isBrowserOpen,
  supportsEmbeddedBrowser,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  sidePaneState,
  recentClosedSidePaneTabs,
  projectName,
  workspaceTabs,
  activeTaskId,
  sidePaneOwnerId,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  activeTaskTitle,
  activeTaskChangeSummary,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeGitSourceId,
  gitState,
  browserNavigationRequest,
  browserRestoreUrls,
  taskNativeSessionLogFile,
  taskSessionFile,
  testMessages,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  conversationFindQuery,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  onSearchResultHighlightRequest,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  appLogoUrl,
  platform,
  reloadSessionDisabled,
  reloadSessionPending,
  handleReloadSession,
  handleSelectTask,
  handleTaskNavBack,
  handleTaskNavForward,
  handleStartDraftInWorkspace,
  handleOpenCommandCenter,
  handleRefreshGit,
  handleBrowserUrlChange,
  handleBrowserPageMetadataChange,
  handleToggleSidebar,
  handleShowSidebar,
  handleToggleTerminal,
  handleToggleBrowser,
  handleOpenBrowserTab,
  handleOpenTreemapping,
  handleOpenWhiteboard,
  handleOpenDeveloperTools,
  handleOpenTerminalTab,
  handleToggleGit,
  handleOpenGitReview,
  handleToggleSidePane,
  handleOpenBrowserUrl,
  handleOpenCodeViewer,
  handleAutoOpenAssistantPptx,
  handleOpenSubagentSession,
  handleOpenBackgroundBash,
  handleOpenSandboxConsole,
  handleOpenSubagentDirectory,
  handleSyncSubagentSessionTabs,
  handleOpenSelectionSideChat,
  handleOpenPlanDetail,
  handleOpenPlanDirectory,
  handleOpenWorkflowRun,
  handleOpenWorkflowRunDirectory,
  handleOpenWorkflowActorSession,
  handleOpenWorkflowWorkspace,
  handleOpenWorkflowArtifact,
  handleCloseCodeViewer,
  handleCloseGit,
  handleActivateSidePaneTab,
  handleReorderSidePaneTab,
  handleCloseSidePaneTab,
  handleCloseOtherSidePaneTabs,
  handleCloseAllSidePaneTabs,
  handleReopenClosedSidePaneTab,
  handleBrowserNavigationRequestHandled,
  setIsTerminalOpen,
  setGitSelectedSourceId,
  taskFindDialogProps,
}: WorkspaceShellLayoutProps) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  // Windows/Linux 也需要外层留白，避免独立面板贴住窗口边缘；桌面统一使用 4px 间距。
  const hasDesktopPanelInset = isMacDesktop || isWindowsDesktop || isLinuxDesktop;
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const workspaceShellRadiusOptions = {
    // 缺省 undefined 会让 chrome 漏判成桌面 12px 圆角。这里收成布尔。
    isDesktop: Boolean(isDesktop),
    isMacDesktop,
    isWindowsDesktop,
    isLinuxDesktop,
    macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
  };
  const workspaceShellWindowChrome = {
    isDesktop: Boolean(isDesktop),
    isMacDesktop,
    isWindowsDesktop,
    isLinuxDesktop,
    macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
    isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
    supportsNativeRoundedCorners: desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
  };
  const workspacePanelRadiusPx = resolveWorkspaceShellPanelRadiusPx(workspaceShellRadiusOptions);
  const workspaceResizeHandleInsetPx = resolveWorkspaceShellResizeHandleInsetPx(
    workspaceShellRadiusOptions,
  );
  const collapsedSidebarWidthPx = hasDesktopPanelInset ? 4 : 0;
  const [draftHeaderDropTargetController, setDraftHeaderDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const filesEditorStore = useFilesEditorStoreApi();
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  // Agent worktree 隔离意图（docs/specs/agent-worktree-isolation.md）：按 workspace key
  // 划分的草稿态状态。壳层没有 sessionId（draftComposerHeader 也没有），SessionPane
  // 在预热会话就绪后消费意图发 attachAgentWorktree；无预热时随 createSession.config 携带。
  // 意图不进全局 store：无跨 pane 广播需求，也避免广播回环。
  const [draftAgentWorktreeBranch, setDraftAgentWorktreeBranch] = useState<string | null>(null);
  const handleConfirmDraftAgentWorktree = useCallback((branch: string) => {
    setDraftAgentWorktreeBranch(branch.trim());
  }, []);
  const handleDraftAgentWorktreeConsumed = useCallback(() => {
    setDraftAgentWorktreeBranch(null);
  }, []);
  // 会话提升（首条消息发出，activeTaskId 从 null 变为有值）后执行根冻结：
  // 无论意图是否已被消费都要清掉，防止下一次新建草稿误带旧意图。
  useEffect(() => {
    if (activeTaskId) {
      setDraftAgentWorktreeBranch(null);
    }
  }, [activeTaskId]);
  const handleOpenPlanDirectoryFromSidePane = useCallback(() => {
    if (!activeTaskId) return;
    handleOpenPlanDirectory({
      workspacePath: workspaceAbsPath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
      parentSessionId: activeTaskId,
    });
  }, [
    activeTaskId,
    handleOpenPlanDirectory,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  ]);
  // 启动器/`+` 菜单的常驻目录入口：壳层只有 activeTaskId，没有 pane 级 rootSessionId，
  // root 由 useAppPanels 回退为 parentSessionId（与计划目录回调同形）。
  const handleOpenSubagentDirectoryFromSidePane = useCallback(() => {
    if (!activeTaskId) return;
    handleOpenSubagentDirectory({
      workspacePath: workspaceAbsPath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
      parentSessionId: activeTaskId,
    });
  }, [
    activeTaskId,
    handleOpenSubagentDirectory,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  ]);
  const screenshotSurfaceRequest = useBrowserScreenshotSurfaceRequest(sidePaneState?.tabs ?? []);
  const screenshotSurfaceTab = screenshotSurfaceRequest
    ? findScreenshotSurfaceTabForRender(sidePaneState?.tabs ?? [], screenshotSurfaceRequest)
    : undefined;
  // v4 pane 绑定持久化（输出中刷新恢复）：renderer 刷新后恢复上次选中的
  // session；CLI/host 进程未死，pane 重订阅即拿 snapshot+续流。
  usePaneSessionPersistence({
    workspaceKey,
    activeSessionId: activeTaskId,
    draftFocusVersion: workspaceShellZCodeState.draftFocusVersion,
    selectSession: (sessionId) => handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity),
  });
  const workspaceShellRef = useRef<HTMLDivElement | null>(null);
  const workspaceSidebarPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationAutoCollapseStateRef = useRef<{
    handleToggleSidebar: () => void;
    handleToggleSidePane: () => void;
    isSidebarVisible: boolean;
    isSidePaneOpen: boolean;
    presentation: WorkspaceSidebarPresentation;
    workspaceKey: string;
  }>({
    handleToggleSidebar,
    handleToggleSidePane,
    isSidebarVisible,
    isSidePaneOpen,
    // 初始占位：sidebarPresentation 在下方才由视口派生，下方同步 effect 会在
    // 任何 resize 触发前写对它。这里只为类型对齐，不能直接引用后面的变量（TDZ）。
    presentation: "inline",
    workspaceKey,
  });
  const conversationAutoCollapseResizeTimerRef = useRef<number | null>(null);
  const conversationAutoCollapseViewportWidthRef = useRef<number | null>(null);
  const workspaceSidebarResizeSessionRef = useRef<WorkspaceSidebarResizeSession | null>(null);
  const [workspaceSidebarPanelWidthPx, setWorkspaceSidebarPanelWidthPx] = useState(
    () => readStoredWorkspaceSidebarWidthPx() ?? WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  );
  const workspaceSidebarPanelWidthPxRef = useRef(workspaceSidebarPanelWidthPx);
  const openWorkspaceKeys = useMemo(
    () => workspaceTabs.map((tab) => tab.workspaceIdentity?.trim() || tab.workspacePath),
    [workspaceTabs],
  );
  // 保活回收：workspace tab 真正关闭（从 openWorkspaceKeys 移除）时，回收属于该 workspace 的
  // side pane terminal 常驻 session（杀 PTY + 销 xterm），避免孤儿进程泄漏。
  // 切 workspace 不会让 workspaceKey 离开这个集合，所以保活的 session 不受影响。
  // 对称下侧 Terminal.tsx:145-177 的 openWorkspaceKeys 回收逻辑。
  useEffect(() => {
    const retained = new Set(openWorkspaceKeys);
    sidePaneTerminalSessionRegistry.releaseByPredicate(
      (entry) => Boolean(entry.workspaceKey) && !retained.has(entry.workspaceKey),
    );
  }, [openWorkspaceKeys]);
  const isSidebarPanelVisible = isSidebarVisible;
  // 形态由视口宽度派生，不落状态：isSidebarVisible 仍然只表达用户意图，
  // 宽度变化永远不会反过来改写它。
  const isNarrowViewport = useIsNarrowViewport();
  const sidebarPresentation = resolveWorkspaceSidebarPresentation({
    isNarrowViewport,
  });
  // 窄视口下大幅右滑打开侧栏。只在抽屉形态且侧栏收起时启用：
  // 宽视口侧栏是内联列常驻可见，没有「打开」这回事；侧栏已展开时它是模态
  // 覆盖层，遮罩会吃掉全部触摸事件。规则见 workspace-shell-swipe-gesture.md。
  useWorkspaceSidebarSwipe({
    shellElementRef: workspaceShellRef,
    isEnabled: sidebarPresentation === "drawer" && !isSidebarPanelVisible,
    onOpenSidebar: handleShowSidebar,
  });
  // Side Pane 遮罩的可见态：与面板的开合判据（下方 useAnimatedResizablePanel 的 open、
  // 包裹层的 isSidePaneVisible）同源，遮罩只是渲染收进抽屉形态常驻，显隐跟随这里。
  const isSidePaneBackdropVisible = workspaceMainView === "chat" && isSidePaneOpen;
  const {
    panelRef: terminalPanelRef,
    panelElementRef: terminalPanelElementRef,
    isVisible: isTerminalVisible,
  } = useAnimatedResizablePanel({
    open: isTerminalOpen,
    expandedSize: "30%",
    rememberExpandedSize: true,
  });
  const {
    panelRef: sidePanePanelRef,
    panelElementRef: sidePanePanelElementRef,
    isVisible: isSidePaneVisible,
  } = useAnimatedResizablePanel({
    // 截图 surface 由 browser-use tab 自己的 fixed 承载层提供尺寸，不能再把整个右侧
    // ResizablePanel 撑开；否则自动化页会闪出空白的 tab 栏，且面板过渡期间 guest surface
    // 仍可能被 Chromium 判定为不可合成。
    open: workspaceMainView === "chat" && isSidePaneOpen,
    expandedSize: resolveWorkspaceSidePaneExpandedSize({
      presentation: sidebarPresentation,
    }),
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
  });
  // 抽屉形态下，从抽屉里点出的导航动作完成后收起抽屉。抽屉是浮在会话之上的覆盖层，
  // 它盖住的正是用户刚要去的那一页（主视图切换、换一条任务、新建任务），
  // 不收起来就只能透过右边的缝隙看到内容已经切换。内联列不收起：侧栏属于布局本身，
  // 切视图后要留在原处。收起只写 isSidebarVisible 这一根轴，不替代导航本身。
  const [settingsNavSlot, setSettingsNavSlot] = useState<HTMLDivElement | undefined>(undefined);
  // 中文说明：ref 回调必须稳定；内联回调会在每次提交时 detach 并 setState，触发 React #185。
  const handleSettingsNavSlotRef = useCallback((node: HTMLDivElement | null) => {
    setSettingsNavSlot(node ?? undefined);
  }, []);
  const collapseSidebarAfterNavigation = useCallback(() => {
    if (
      shouldCollapseWorkspaceSidebarAfterNavigation({
        presentation: sidebarPresentation,
        isSidebarVisible: isSidebarPanelVisible,
      })
    ) {
      handleToggleSidebar();
    }
  }, [handleToggleSidebar, isSidebarPanelVisible, sidebarPresentation]);
  const workspaceSessionActionDisabled =
    Boolean(workspaceReadOnlyReason) || reloadSessionDisabled || reloadSessionPending;
  // 侧栏收起后，New Task 只从顶部浮层露出；展开时走侧栏入口。
  const showTopOverlayNewTaskButton = !isSidebarVisible;
  const workspaceSidebarResizeLabel = intl.formatMessage({
    id: "workspaceSidebar.resizeSidebar",
  });

  useEffect(() => {
    conversationAutoCollapseStateRef.current = {
      handleToggleSidebar,
      handleToggleSidePane,
      isSidebarVisible,
      isSidePaneOpen,
      presentation: sidebarPresentation,
      workspaceKey,
    };
  }, [
    handleToggleSidebar,
    handleToggleSidePane,
    isSidebarVisible,
    isSidePaneOpen,
    sidebarPresentation,
    workspaceKey,
  ]);

  useEffect(() => {
    if (workspaceMainView !== "chat") {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const readConversationWidthPx = () =>
      conversationPanelElementRef.current?.getBoundingClientRect().width ?? null;

    // resize 基线只记宽度：软键盘弹出只压高度、window.innerWidth 不变，
    // 宽度没变就不是用户改窗口，不能进自动收起。基线在订阅建立时取一次，
    // 避免首个键盘 resize 因无基线可比而按旧语义放行。
    conversationAutoCollapseViewportWidthRef.current = window.innerWidth;

    const collapseSidebarIfStillNarrow = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidebar: collapseSidebar,
        isSidebarVisible: latestIsSidebarVisible,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      if (latestIsSidebarVisible && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起左侧栏", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidebar();
      }
    };

    const runAutoCollapseForWindowResize = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidePane: collapseSidePane,
        isSidePaneOpen: latestIsSidePaneOpen,
        presentation: latestPresentation,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      // 功能说明：自动收起只响应用户改变窗口尺寸后的 conversation 实际宽度。
      // 不监听 conversation 自身 ResizeObserver，避免用户手动打开面板时又被策略关回去。
      // 软键盘只改高度不改宽度、抽屉形态下面板本就不占宽度，两者都不得收起，
      // 否则手机上点一下输入框键盘一弹面板就消失（基线与形态判定见判据函数注释）。
      const previousViewportWidthPx = conversationAutoCollapseViewportWidthRef.current;
      const nextViewportWidthPx = window.innerWidth;
      conversationAutoCollapseViewportWidthRef.current = nextViewportWidthPx;
      if (
        !shouldRunConversationAutoCollapseForViewportResize({
          presentation: latestPresentation,
          previousViewportWidthPx,
          nextViewportWidthPx,
        })
      ) {
        return;
      }
      if (latestIsSidePaneOpen && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起右侧面板", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidePane();
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(collapseSidebarIfStillNarrow);
        });
        return;
      }

      collapseSidebarIfStillNarrow();
    };

    const handleWindowResize = () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
      }

      // 大会话 resize trace 显示自动收起侧栏会触发 WorkspaceSidebar
      // 和大量 tooltip/menu 子树重渲染；拖拽窗口过程中先等 resize idle，再保留原收起语义。
      conversationAutoCollapseResizeTimerRef.current = window.setTimeout(() => {
        conversationAutoCollapseResizeTimerRef.current = null;
        runAutoCollapseForWindowResize();
      }, CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS);
    };

    window.addEventListener("resize", handleWindowResize);

    return () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
        conversationAutoCollapseResizeTimerRef.current = null;
      }
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [workspaceMainView]);

  useEffect(() => {
    workspaceSidebarPanelWidthPxRef.current = workspaceSidebarPanelWidthPx;
  }, [workspaceSidebarPanelWidthPx]);

  const applyWorkspaceSidebarWidthDuringDrag = useCallback(
    (nextWidthPx: number) => {
      workspaceSidebarPanelWidthPxRef.current = nextWidthPx;
      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      // 大会话 trace 显示拖拽侧栏时每个 pointermove 都 setState，
      // 会让 WorkspaceShellLayout、WorkspaceSidebar 和 ChatView 大树反复 render。
      // 拖拽中的宽度只是瞬时布局值，直接写 CSS 变量；释放时再提交 React state。
      shellElement.style.setProperty(
        WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR,
        `${isSidebarPanelVisible ? nextWidthPx : collapsedSidebarWidthPx}px`,
      );
      shellElement.style.setProperty(WORKSPACE_SIDEBAR_WIDTH_CSS_VAR, `${nextWidthPx}px`);
    },
    [collapsedSidebarWidthPx, isSidebarPanelVisible],
  );

  useEffect(() => {
    if (readStoredWorkspaceSidebarWidthPx() !== null) {
      return;
    }

    const legacyRatio = readLegacyWorkspaceSidebarWidthRatio();
    const shellElement = workspaceShellRef.current;
    if (legacyRatio === null || !shellElement) {
      return;
    }

    const containerWidthPx = shellElement.getBoundingClientRect().width;
    if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
      return;
    }

    // 外层 workspace shell 不再使用 react-resizable-panels，
    // 但旧版本已持久化过 sidebar/content 百分比。迁移成像素宽度后，
    // 普通窗口 resize 不会再触发 RRP layout store，同时仍保留用户拖出的侧栏宽度。
    const migratedWidthPx = clampWorkspaceSidebarWidth(
      containerWidthPx * legacyRatio,
      containerWidthPx,
    );
    workspaceSidebarPanelWidthPxRef.current = migratedWidthPx;
    setWorkspaceSidebarPanelWidthPx(migratedWidthPx);
    persistWorkspaceSidebarWidthPx(migratedWidthPx);
  }, []);

  const applyWorkspaceSidebarWidth = useCallback(
    (nextWidthPx: number, options: { persist: boolean }) => {
      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const resolvedWidthPx = clampWorkspaceSidebarWidth(nextWidthPx, containerWidthPx);
      workspaceSidebarPanelWidthPxRef.current = resolvedWidthPx;
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) =>
        currentWidthPx === resolvedWidthPx ? currentWidthPx : resolvedWidthPx,
      );
      if (options.persist) {
        persistWorkspaceSidebarWidthPx(resolvedWidthPx);
      }
      return resolvedWidthPx;
    },
    [],
  );

  const handleWorkspaceSidebarResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      const containerWidthPx = shellElement.getBoundingClientRect().width;
      workspaceSidebarResizeSessionRef.current = {
        containerWidthPx,
        pointerId: event.pointerId,
        startWidthPx: workspaceSidebarPanelWidthPxRef.current,
        startX: event.clientX,
      };
      setWorkspaceSidebarResizeActive({
        active: true,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement,
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [isSidebarPanelVisible],
  );

  const handleWorkspaceSidebarResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const nextWidthPx = clampWorkspaceSidebarWidth(
        resizeSession.startWidthPx + event.clientX - resizeSession.startX,
        resizeSession.containerWidthPx,
      );
      applyWorkspaceSidebarWidthDuringDrag(nextWidthPx);
      event.currentTarget.setAttribute("aria-valuenow", String(Math.round(nextWidthPx)));
    },
    [applyWorkspaceSidebarWidthDuringDrag],
  );

  const finishWorkspaceSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      workspaceSidebarResizeSessionRef.current = null;
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) => {
        const finalWidthPx = workspaceSidebarPanelWidthPxRef.current;
        return currentWidthPx === finalWidthPx ? currentWidthPx : finalWidthPx;
      });
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!cancelled) {
        persistWorkspaceSidebarWidthPx(workspaceSidebarPanelWidthPxRef.current);
      }
    },
    [],
  );

  const handleWorkspaceSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible) {
        return;
      }

      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const maxWidthPx =
        containerWidthPx && containerWidthPx > 0
          ? containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO
          : workspaceSidebarPanelWidthPxRef.current;
      let nextWidthPx: number | null = null;

      if (event.key === "ArrowLeft") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current - WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "ArrowRight") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current + WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "Home") {
        nextWidthPx = WORKSPACE_SIDEBAR_MIN_WIDTH_PX;
      } else if (event.key === "End") {
        nextWidthPx = maxWidthPx;
      }

      if (nextWidthPx === null) {
        return;
      }

      event.preventDefault();
      applyWorkspaceSidebarWidth(nextWidthPx, { persist: true });
    },
    [applyWorkspaceSidebarWidth, isSidebarPanelVisible],
  );

  useEffect(() => {
    return () => {
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
    };
  }, []);

  const activeSearchResultHighlightRequest = useMemo(() => {
    if (!searchResultHighlightRequest || searchResultHighlightRequest.taskId !== activeTaskId) {
      return null;
    }

    const activeWorkspaceKey = buildTaskWorkspaceKey(workspaceAbsPath, workspaceIdentity);
    const requestWorkspaceKey = buildTaskWorkspaceKey(
      searchResultHighlightRequest.workspacePath,
      searchResultHighlightRequest.workspaceIdentity,
    );
    return activeWorkspaceKey === requestWorkspaceKey ? searchResultHighlightRequest : null;
  }, [activeTaskId, searchResultHighlightRequest, workspaceAbsPath, workspaceIdentity]);
  const renderChatFindDialog = () => <TaskFindDialog {...taskFindDialogProps} placement="chat" />;
  const gitDirtyFileCount = useMemo(() => {
    // 关键业务逻辑：同一个文件可能同时出现在 staged / unstaged。
    // 这里按 path 去重后再统计，避免入口里“未提交更改文件数”被重复计算。
    return getGitDirtyFileCount(gitState.datasets);
  }, [gitState.datasets.staged, gitState.datasets.unstaged]);
  const workspaceRemoteTarget = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.remoteTarget,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  const workspaceLocalPathForRemoteMcpSync = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.localWorkspacePath,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  const workspaceShellSplitStyle = useMemo(
    () =>
      ({
        "--workspace-sidebar-panel-width": resolveWorkspaceSidebarPanelWidthCssValue({
          presentation: sidebarPresentation,
          isSidebarVisible: isSidebarPanelVisible,
          inlineWidthPx: workspaceSidebarPanelWidthPx,
          collapsedInlineWidthPx: collapsedSidebarWidthPx,
        }),
        "--workspace-sidebar-width": `${workspaceSidebarPanelWidthPx}px`,
        "--workspace-panel-radius": `${workspacePanelRadiusPx}px`,
        "--workspace-resize-handle-inset": `${workspaceResizeHandleInsetPx}px`,
      }) as CSSProperties,
    [
      collapsedSidebarWidthPx,
      isSidebarPanelVisible,
      sidebarPresentation,
      workspacePanelRadiusPx,
      workspaceResizeHandleInsetPx,
      workspaceSidebarPanelWidthPx,
    ],
  );
  const activePreviewPath = useMemo(() => {
    const activeSidePaneTab =
      sidePaneState?.tabs.find((tab) => tab.id === sidePaneState.activeTabId) ?? null;
    return activeSidePaneTab?.type === "code-viewer"
      ? (activeSidePaneTab.source.path ?? null)
      : null;
  }, [sidePaneState]);
  const findFileLinkOwnerWorkspace = useCallback(
    (
      targetPath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspaceRemoteSessionId?: string,
    ) => {
      const matches = workspaceTabs.filter(
        (tab) =>
          isWorkspaceFilePathInside(tab.workspacePath, targetPath) &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity) &&
          (!targetWorkspaceRemoteSessionId ||
            tab.remoteSessionId === targetWorkspaceRemoteSessionId),
      );
      if (matches.length === 0) {
        return null;
      }
      return (
        matches.sort((left, right) => {
          const leftActive = left.workspaceIdentity === workspaceIdentity ? 1 : 0;
          const rightActive = right.workspaceIdentity === workspaceIdentity ? 1 : 0;
          if (leftActive !== rightActive) {
            return rightActive - leftActive;
          }
          return right.workspacePath.length - left.workspacePath.length;
        })[0] ?? null
      );
    },
    [workspaceIdentity, workspaceTabs],
  );
  const openFilesExplorerTarget = useCallback(
    (target: {
      workspacePath: string;
      workspaceName?: string;
      workspaceIdentity?: string;
      workspaceRemoteSessionId?: string;
      revealPath?: string;
    }) => {
      void runWebNavigation(() => {
        const workspace = toFilesWorkspaceRef({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          remoteSessionId: target.workspaceRemoteSessionId,
        });
        filesEditorStore.getState().setExplorerWorkspaceKey(filesWorkspaceKey(workspace));
        if (target.revealPath) {
          filesEditorStore.getState().setRevealPath(target.revealPath);
        }
        onShowFiles();
      });
    },
    [filesEditorStore, onShowFiles],
  );
  const showChatMainView = useCallback(() => {
    onWorkspaceMainViewChange("chat");
  }, [onWorkspaceMainViewChange]);
  const primaryNavigationBack =
    workspaceMainView === "plugin-store" ? handleManageInstalledPlugins : handleTaskNavBack;
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  const handleCreateTaskInChat = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      // workspaceReadOnlyReason 判定的是活动 workspace；当 request 显式带 targetWorkspace 时
      // 目标另属他项目（跨项目发起已保存工作流），
      // 活动 workspace 的只读性不适用，真正的守卫是 root 动作对 target 的 isWorkspaceReadOnly。
      const hasTargetWorkspace =
        typeof request === "object" && request !== null && Boolean(request.targetWorkspace);
      if (!hasTargetWorkspace && workspaceReadOnlyReason) {
        return;
      }
      void runWebNavigation(() => {
        onShowTasks();
        showChatMainView();
        onCreateTask(request);
      });
    },
    [onCreateTask, onShowTasks, showChatMainView, workspaceReadOnlyReason],
  );
  const shellWorkbenchBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      activeTaskId
        ? {
            workspaceScope: {
              workspacePath: workspaceAbsPath,
              ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
              ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
            },
            sessionId: activeTaskId,
          }
        : null,
    [activeTaskId, workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId],
  );
  const handleCreateAutomationInChat = useCallback(
    (prompt: string, targetWorkspace?: { workspacePath: string; workspaceIdentity?: string }) => {
      // 带 target 时跳过活动 workspace 只读检查，交由 handleCreateTaskInChat / root 动作在
      // target 上校验；无 target 时形状不变。
      if (!targetWorkspace && workspaceReadOnlyReason) return;
      handleCreateTaskInChat({
        initialPrompt: prompt,
        ...(targetWorkspace ? { targetWorkspace } : {}),
      });
    },
    [handleCreateTaskInChat, workspaceReadOnlyReason],
  );
  // 工作流「运行」现由中枢直接启动：GUI 建空会话 +
  // 发 startSavedWorkflow 命令，不再合成对话文案。本层只在 accepted 后把会话切到前台。
  const handleSelectTaskInChat = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
      targetRemoteSessionId?: string,
      expectedUnreadAt?: number,
    ) => {
      void runWebNavigation(() => {
        const workspaceResult = ensureTaskNavigationWorkspace({
          workspacePath: targetWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          activateTabByPath: tabStoreApi.getState().activateTabByPath,
          addLocalWorkspaceTab: (workspacePath) => {
            tabStoreApi.getState().addTab(workspacePath);
          },
        });
        if (!workspaceResult.accepted) {
          logger.warn("[automations] 运行历史目标远程 workspace 未连接，保留当前页面", {
            sessionId: taskId,
            workspaceIdentity: targetWorkspaceIdentity,
            workspacePath: targetWorkspacePath,
          });
          toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
          return;
        }
        if (workspaceResult.openedLocalTab) {
          logger.info("[automations] 为运行历史会话补开本地 workspace tab", {
            sessionId: taskId,
            workspacePath: targetWorkspacePath,
          });
        }
        const resolvedRemoteSessionId =
          targetRemoteSessionId ??
          workspaceTabs.find(
            (tab) =>
              (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
              (targetWorkspaceIdentity?.trim() || targetWorkspacePath),
          )?.remoteSessionId;
        const target: V4SplitPaneSessionTarget = {
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity?.trim()
            ? { workspaceIdentity: targetWorkspaceIdentity }
            : {}),
          ...(resolvedRemoteSessionId ? { remoteSessionId: resolvedRemoteSessionId } : {}),
          sessionId: taskId,
        };
        selectWorkbenchSession(shellWorkbenchBinding, target);
        onShowTasks();
        showChatMainView();
        handleSelectTask(
          targetWorkspacePath,
          taskId,
          targetWorkspaceIdentity,
          ...(typeof expectedUnreadAt === "number" ? [expectedUnreadAt] : []),
        );
      });
    },
    [
      handleSelectTask,
      intl,
      onShowTasks,
      shellWorkbenchBinding,
      showChatMainView,
      tabStoreApi,
      workspaceTabs,
    ],
  );
  // 中枢直接启动 accepted 后切到新会话（run 卡已在顶部）：复用运行历史那条导航，
  // target 恒带工作流所属项目坐标（不变式 7），remoteSessionId 决定连接 endpoint。
  const handleNavigateToLaunchedRun = useCallback(
    (target: SavedWorkflowLaunchTarget, sessionId: string) => {
      handleSelectTaskInChat(
        target.workspacePath,
        sessionId,
        target.workspaceIdentity,
        target.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );
  // 工作流运行历史「查看实例」：先回到发起它的会话（侧栏页只在 chat 视图里可见），再开实例详情页。
  const handleOpenSavedWorkflowRun = useCallback(
    (params: SavedWorkflowsOpenRunParams) => {
      // 中枢是跨项目视图：实例必须开在发起它的项目，而非活动项目。
      // params 恒带 workspacePath/identity；仅在异常缺省时兜底回退到活动 workspace。
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      // remoteSessionId 不在契约里：按目标 workspace 从已打开 tab 反查；命中活动项目即取活动值。
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      void runWebNavigation(() => {
        handleSelectTaskInChat(
          targetWorkspacePath,
          params.sessionId,
          targetWorkspaceIdentity,
          targetRemoteSessionId,
        );
        handleOpenWorkflowRun({
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
          ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
          parentSessionId: params.sessionId,
          toolCallId: params.toolCallId,
          runId: params.runId,
          workflowName: params.workflowName,
        });
      });
    },
    [
      handleOpenWorkflowRun,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  // 侧栏运行行：与 composer 徽标
  // 同一跳转——先选中会话，再开 run pane。没有 toolCallId 的 run（不该有）只选中会话。
  const handleOpenSidebarWorkflowRun = useCallback(
    (target: WorkflowRunOpenTarget) => {
      if (target.run.toolCallId === undefined) {
        const targetRemoteSessionId = workspaceTabs.find(
          (tab) =>
            tab.workspacePath === target.workspacePath &&
            (!target.workspaceIdentity || tab.workspaceIdentity === target.workspaceIdentity),
        )?.remoteSessionId;
        handleSelectTaskInChat(
          target.workspacePath,
          target.sessionId,
          target.workspaceIdentity,
          targetRemoteSessionId,
        );
        return;
      }
      handleOpenSavedWorkflowRun({
        sessionId: target.sessionId,
        runId: target.run.runId,
        toolCallId: target.run.toolCallId,
        workflowName: target.run.name ?? "",
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [handleOpenSavedWorkflowRun, handleSelectTaskInChat, workspaceTabs],
  );
  // 中枢的产物 chip：与「查看实例」逐字同构（同一条「先回到发起它的会话」的路径），
  // 只是终点是 `workflow-artifact` tab 而不是 run 详情页。
  const handleOpenSavedWorkflowArtifact = useCallback(
    (params: SavedWorkflowsOpenArtifactParams) => {
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      void runWebNavigation(() => {
        handleSelectTaskInChat(
          targetWorkspacePath,
          params.sessionId,
          targetWorkspaceIdentity,
          targetRemoteSessionId,
        );
        handleOpenWorkflowArtifact({
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
          ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
          parentSessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          ...(params.title === undefined ? {} : { title: params.title }),
          // 中枢的 chip 载荷带得到 contentType（html 产物据它直接开浏览器 tab）；`sourcePath`
          // 那份载荷没有，由 `handleOpenWorkflowArtifact` 自己查 journal 补。
          ...(params.contentType === undefined ? {} : { contentType: params.contentType }),
        });
      });
    },
    [
      handleOpenWorkflowArtifact,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  const handlePaneActiveSessionChange = useCallback(
    (
      scope: {
        workspacePath: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
      },
      sessionId: string,
    ) => {
      handleSelectTaskInChat(
        scope.workspacePath,
        sessionId,
        scope.workspaceIdentity,
        scope.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );

  const canOpenSessionInSplitPane = useCallback(
    (target: V4SplitPaneSessionTarget) => {
      return canPlaceWorkbenchSessionInSplit(shellWorkbenchBinding, target, {
        mode: "context-menu",
        side: "right",
      });
    },
    [shellWorkbenchBinding],
  );
  const handleOpenSessionInSplitPane = useCallback(
    (target: V4SplitPaneSessionTarget) => {
      void runWebNavigation(() => {
        const shouldSelectTarget = placeWorkbenchSessionInSplit(shellWorkbenchBinding, target, {
          mode: "context-menu",
          side: "right",
        });
        if (!shouldSelectTarget) return;
        showChatMainView();
        handleSelectTask(target.workspacePath, target.sessionId, target.workspaceIdentity);
      });
    },
    [handleSelectTask, shellWorkbenchBinding, showChatMainView],
  );
  const handleStartDraftInWorkspaceInChat = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      void runWebNavigation(() => {
        onShowTasks();
        showChatMainView();
        handleStartDraftInWorkspace(
          targetWorkspacePath,
          targetWorkspaceIdentity,
          targetWorkspacePurpose,
          createSource,
        );
      });
    },
    [handleStartDraftInWorkspace, onShowTasks, showChatMainView],
  );
  const handleCreateProjectDraft = useCallback(
    (path: string, identity?: string) =>
      handleStartDraftInWorkspaceInChat(path, identity, undefined, "project"),
    [handleStartDraftInWorkspaceInChat],
  );
  // 侧栏收到的、会改变主视图或当前任务的回调，统一套一层「抽屉形态下动作完成后收起」。
  // 保证引用稳定，避免把内联箭头函数传进侧栏导致其子树每次渲染都重新挂载。
  const handleSelectTaskFromSidebar = useCallback(
    (...args: Parameters<typeof handleSelectTaskInChat>) => {
      handleSelectTaskInChat(...args);
      collapseSidebarAfterNavigation();
    },
    [collapseSidebarAfterNavigation, handleSelectTaskInChat],
  );
  const handleCreateTaskFromSidebar = useCallback(
    (...args: Parameters<typeof handleCreateTaskInChat>) => {
      handleCreateTaskInChat(...args);
      collapseSidebarAfterNavigation();
    },
    [collapseSidebarAfterNavigation, handleCreateTaskInChat],
  );
  const handleCreateProjectDraftFromSidebar = useCallback(
    (...args: Parameters<typeof handleCreateProjectDraft>) => {
      handleCreateProjectDraft(...args);
      collapseSidebarAfterNavigation();
    },
    [collapseSidebarAfterNavigation, handleCreateProjectDraft],
  );
  const handleOpenCommandCenterFromSidebar = useCallback(() => {
    handleOpenCommandCenter();
    collapseSidebarAfterNavigation();
  }, [collapseSidebarAfterNavigation, handleOpenCommandCenter]);
  const handleOpenAutomationsFromSidebar = useCallback(() => {
    handleOpenAutomations();
    collapseSidebarAfterNavigation();
  }, [collapseSidebarAfterNavigation, handleOpenAutomations]);
  const handleOpenPluginStoreFromSidebar = useCallback(() => {
    handleOpenPluginStore();
    collapseSidebarAfterNavigation();
  }, [collapseSidebarAfterNavigation, handleOpenPluginStore]);
  const activeWorkspacePurpose =
    workspaceTabs.find(
      (tab) =>
        tab.workspacePath === workspaceAbsPath &&
        (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
    )?.workspacePurpose ?? "project";
  const handleSelectConversationWorkspace = useCallback(async () => {
    if (!onResolveConversationWorkspace) {
      return;
    }
    let targetWorkspacePath: string;
    try {
      targetWorkspacePath = await onResolveConversationWorkspace();
    } catch (error) {
      logger.error("[WorkspaceShellLayout] 切换对话 workspace 失败", {
        error,
      });
      return;
    }
    if ((workspaceIdentity?.trim() || workspaceAbsPath) !== targetWorkspacePath) {
      requestV4ComposerDraftWorkspaceTransfer({
        sourceWorkspacePath: workspaceAbsPath,
        sourceWorkspaceIdentity: workspaceIdentity,
        targetWorkspacePath,
      });
    }
    handleStartDraftInWorkspaceInChat(targetWorkspacePath, undefined, "conversation");
  }, [
    handleStartDraftInWorkspaceInChat,
    onResolveConversationWorkspace,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleSelectComposerPlugin = useCallback(
    (mention: ComposerMentionPrefill) => {
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspaceAbsPath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceAbsPath, workspaceIdentity],
  );
  // v4 pane 生命周期回调（稳定引用，供 memo 友好的 pane 宿主消费）：
  // createSession/fork 后接入既有选择路径；删除会话后回 draft。
  const handleV4SessionCreated = useCallback(
    (sessionId: string) => {
      handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity);
    },
    [handleSelectTask, workspaceAbsPath, workspaceIdentity],
  );
  // 草稿态 composer contextHeader：workspace 切换菜单 +
  // Git 分支切换器，与旧 ChatView 空态 contextHeaderContent 同构。壳级能力
  // （workspaceTabs / 远程连接回调）在此闭合，pane 只收 ReactNode。
  // onSelectWorkspace 语义与旧版一致：切到目标 workspace 的新草稿。
  const draftComposerHeader = useMemo(
    () => (
      <>
        <ChatEmptyWorkspacePreviewMenu
          workspacePath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          isWindowsDesktop={isWindowsDesktop}
          workspaceTabs={workspaceTabs}
          onSelectWorkspace={(workspaceTab) =>
            handleStartDraftInWorkspaceInChat(
              workspaceTab.workspacePath,
              workspaceTab.workspaceIdentity,
              workspaceTab.workspacePurpose,
            )
          }
          onSelectConversationWorkspace={handleSelectConversationWorkspace}
          onOpenFolder={onOpenFolderFromWorkspaceMenu}
          onCreateWorkspace={onCreateScratchWorkspace}
          allowOpenWorkspace={allowOpenWorkspace}
          allowRemoteWorkspace={allowRemoteWorkspace}
          remoteWorkspaceSessions={remoteWorkspaceSessions}
          onConnectRemote={onConnectRemote}
          onSelectRemoteProject={onSelectRemoteProject}
          onCancelRemoteProject={onCancelRemoteProject}
        />
        {isOfficeMode ? (
          <WorkspacePluginPreview
            onOpen={handleOpenPluginStore}
            onSelectPlugin={handleSelectComposerPlugin}
            workspacePath={workspaceAbsPath}
            workspaceIdentity={workspaceIdentity}
            remoteSessionId={workspaceRemoteSessionId ?? undefined}
          />
        ) : !isOfficeMode && activeWorkspacePurpose === "project" ? (
          <GitBranchSwitcher
            workspacePath={workspaceAbsPath}
            gitSummary={gitState.summary}
            dirtyFileCount={gitDirtyFileCount}
            onRefreshGit={handleRefreshGit}
            className="px-0 pt-0"
            popoverClassName="w-72"
            branchListClassName="max-h-48"
            // 输入框区域在底部，Radix 碰撞避让会把分支菜单翻到下方。
            // 这里锁定上方弹出，避免菜单遮挡输入区并保持操作方向稳定。
            avoidPopoverCollisions={false}
            agentWorktreeDraft={{
              attachedBranch: draftAgentWorktreeBranch,
              attachPending: false,
              onConfirmWorktree: handleConfirmDraftAgentWorktree,
            }}
          />
        ) : null}
      </>
    ),
    [
      isOfficeMode,
      workspaceRemoteSessionId,
      handleOpenPluginStore,
      handleSelectComposerPlugin,
      allowOpenWorkspace,
      allowRemoteWorkspace,
      activeWorkspacePurpose,
      gitDirtyFileCount,
      gitState.summary,
      handleRefreshGit,
      handleSelectConversationWorkspace,
      handleStartDraftInWorkspaceInChat,
      isWindowsDesktop,
      onCancelRemoteProject,
      onConnectRemote,
      onOpenFolderFromWorkspaceMenu,
      onCreateScratchWorkspace,
      onSelectRemoteProject,
      remoteWorkspaceSessions,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
      draftAgentWorktreeBranch,
      handleConfirmDraftAgentWorktree,
    ],
  );
  const handleV4SessionDeleted = useCallback(() => {
    if (activeTaskId) {
      for (const tab of sidePaneState?.tabs ?? []) {
        if (tab.type === "selection-side-chat" && tab.parentSessionId === activeTaskId) {
          handleCloseSidePaneTab(tab.id);
        }
      }
    }
    handleStartDraftInWorkspaceInChat(workspaceAbsPath, workspaceIdentity);
  }, [
    activeTaskId,
    handleCloseSidePaneTab,
    handleStartDraftInWorkspaceInChat,
    sidePaneState?.tabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleOpenMarkdownFileLink = useCallback(
    async (target: WorkspacePathOpenRequest) => {
      if (workspaceReadOnlyReason && target.serviceScope !== "base-local") {
        return;
      }
      try {
        const fileService = selectWorkspacePathFileService(
          target,
          services.fileService,
          baseServices.fileService,
        );
        const fileStat = await fileService.stat({
          path: target.path,
        });
        if (fileStat.type === "file") {
          if (
            shouldOpenAssistantHtmlInBrowser({
              path: target.path,
              workspaceIdentity: target.workspaceIdentity,
              workspaceRemoteSessionId: target.workspaceRemoteSessionId,
            })
          ) {
            handleOpenBrowserUrl(toFileUrl(target.path));
            return;
          }
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
          return;
        }

        if (target.serviceScope === "base-local") {
          openFilesExplorerTarget({
            workspacePath: target.path,
            workspaceName: target.label || getPathLeaf(target.path),
            revealPath: target.path,
          });
          return;
        }

        const ownerWorkspace = findFileLinkOwnerWorkspace(
          target.path,
          target.workspaceIdentity,
          target.workspaceRemoteSessionId,
        );
        if (ownerWorkspace) {
          openFilesExplorerTarget({
            workspacePath: ownerWorkspace.workspacePath,
            workspaceName: ownerWorkspace.label,
            workspaceIdentity: ownerWorkspace.workspaceIdentity,
            workspaceRemoteSessionId: ownerWorkspace.remoteSessionId,
            revealPath: areWorkspaceFilePathsEqual(ownerWorkspace.workspacePath, target.path)
              ? undefined
              : target.path,
          });
          return;
        }

        openFilesExplorerTarget({
          workspacePath: target.path,
          workspaceName: target.label || getPathLeaf(target.path),
          revealPath: target.path,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[WorkspaceShell] 打开 markdown 文件链接失败", {
          path: target.path,
          error: message,
        });
        if (shouldFallbackWorkspacePathToCodeViewer(target)) {
          // markdown file link 可能指向已不存在的路径。
          // stat 失败时仍交给 CodeViewer 展示具体读文件错误，避免点击完全无反馈。
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
        }
        toast(intl.formatMessage({ id: "workspaceFileTree.openFailed" }));
      }
    },
    [
      findFileLinkOwnerWorkspace,
      baseServices.fileService,
      handleOpenBrowserUrl,
      handleOpenCodeViewer,
      intl,
      openFilesExplorerTarget,
      services.fileService,
      workspaceReadOnlyReason,
    ],
  );
  useEffect(
    () =>
      addWorkspacePathOpenRequestListener((target) => {
        void handleOpenMarkdownFileLink(target);
      }),
    [handleOpenMarkdownFileLink],
  );
  // 会话引用芯片点击：先发高亮请求、再切到目标会话（与命令中心来源跳转同序）。
  // 目标工作区按 sessionId 反查已加载会话索引；反查不到回退当前工作区。
  // 能搜到就能跳：不限制跨工作区，跨区时 handleSelectTaskInChat 负责补开 tab。
  const handleOpenSessionCitation = useCallback(
    (target: MessageSessionCitationTarget) => {
      const sessionId = target.sessionId.trim();
      if (!sessionId) return;
      const workspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspaceAbsPath, workspaceIdentity);
      const candidates: Array<{
        taskId: string;
        workspacePath: string;
        workspaceIdentity?: string;
      }> = workspaceState.taskListCache ?? [];
      const resolved = resolveSessionCitationWorkspace(candidates, sessionId, {
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      const targetWorkspacePath = resolved?.workspacePath ?? workspaceAbsPath;
      const targetWorkspaceIdentity = resolved?.workspaceIdentity ?? workspaceIdentity;
      const snippet = target.fragment ? citationJumpText(target.fragment) : "";
      onSearchResultHighlightRequest?.({
        taskId: sessionId,
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        query: snippet || target.label,
        ...(snippet ? { snippet } : {}),
      });
      handleSelectTaskInChat(targetWorkspacePath, sessionId, targetWorkspaceIdentity);
    },
    [handleSelectTaskInChat, onSearchResultHighlightRequest, workspaceAbsPath, workspaceIdentity],
  );
  const handleRevealGitFileInTree = useCallback(
    (path: string) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      openFilesExplorerTarget({
        workspacePath: workspaceAbsPath,
        workspaceName: projectName,
        workspaceIdentity,
        workspaceRemoteSessionId,
        revealPath: path,
      });
    },
    [
      openFilesExplorerTarget,
      projectName,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
      workspaceReadOnlyReason,
    ],
  );
  const activeSelectionSideChatSessionId = activeTaskId
    ? (getActiveSelectionSideChatTab(sidePaneState, {
        workspaceKey,
        parentSessionId: activeTaskId,
      })?.childSessionId ?? null)
    : null;
  const handleOpenSelectionSideConversationLauncher = useCallback(() => {
    if (!activeTaskId) return;
    const requested = requestSelectionSideChatOpen(
      buildSelectionSideChatKey(workspaceKey, activeTaskId),
    );
    if (!requested) {
      // 固定入口由当前主 SessionPane 承接命令；若 pane 尚未挂载，不允许壳层自行拼接远程身份或协议。
      logger.warn("[WorkspaceShell] 辅助对话入口没有可用的主会话控制器", {
        parentSessionId: activeTaskId,
        workspaceKey,
      });
    }
  }, [activeTaskId, workspaceKey]);
  const renderSidePanePanel = () => (
    <AnimatedSidePanePanel
      services={services}
      isDesktop={isDesktop}
      isWindowsDesktop={isWindowsDesktop}
      frameClassName={resolveWorkspaceShellWindowChromeClass(workspaceShellWindowChrome)}
      showWindowControls={usesInlineWindowControls}
      isVisible={isSidePaneVisible}
      presentation={sidebarPresentation}
      onCloseSidePane={handleToggleSidePane}
      toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
      sidePaneState={sidePaneState}
      recentClosedSidePaneTabs={recentClosedSidePaneTabs}
      isBrowserOpen={isBrowserOpen}
      supportsEmbeddedBrowser={supportsEmbeddedBrowser}
      workspaceAbsPath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      activeTaskId={activeTaskId}
      sidePaneOwnerId={sidePaneOwnerId}
      gitState={gitState}
      activeGitSourceId={activeGitSourceId}
      panelRef={sidePanePanelRef}
      panelElementRef={sidePanePanelElementRef}
      browserNavigationRequest={browserNavigationRequest}
      browserRestoreUrls={browserRestoreUrls}
      screenshotSurfaceRequest={screenshotSurfaceRequest}
      screenshotSurfaceTabId={screenshotSurfaceTab?.id ?? null}
      fileChangeFindActiveIndex={fileChangeFindActiveIndex}
      fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
      fileChangeFindQuery={fileChangeFindQuery}
      onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
      onCloseCodeViewer={handleCloseCodeViewer}
      onCloseGit={handleCloseGit}
      onActivateTab={handleActivateSidePaneTab}
      onReorderTab={handleReorderSidePaneTab}
      onCloseTab={handleCloseSidePaneTab}
      onCloseOtherTabs={handleCloseOtherSidePaneTabs}
      onCloseAllTabs={handleCloseAllSidePaneTabs}
      onReopenClosedTab={handleReopenClosedSidePaneTab}
      onOpenBrowserTab={handleOpenBrowserTab}
      onOpenWhiteboard={handleOpenWhiteboard}
      onOpenDeveloperTools={handleOpenDeveloperTools}
      onOpenTerminalTab={handleOpenTerminalTab}
      onOpenReviewTab={handleToggleGit}
      onOpenSelectionSideConversation={handleOpenSelectionSideConversationLauncher}
      onOpenPlanDetail={handleOpenPlanDetail}
      onOpenPlanDirectory={handleOpenPlanDirectoryFromSidePane}
      onOpenSubagentDirectory={handleOpenSubagentDirectoryFromSidePane}
      onRevealGitFileInTree={handleRevealGitFileInTree}
      onOpenInFilesView={(source) => {
        onShowFiles();
        filesEditorStore.getState().requestOpenPath({
          workspace: {
            workspacePath: source.workspacePath ?? workspaceAbsPath,
            ...(source.workspaceIdentity ? { workspaceIdentity: source.workspaceIdentity } : {}),
            ...(source.workspaceRemoteSessionId
              ? { workspaceRemoteSessionId: source.workspaceRemoteSessionId }
              : {}),
          },
          path: source.path,
        });
        collapseSidebarAfterNavigation();
      }}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      onOpenCodeViewer={handleOpenCodeViewer}
      onOpenFileLink={handleOpenMarkdownFileLink}
      onOpenBackgroundBash={handleOpenBackgroundBash}
      onOpenSubagentSession={handleOpenSubagentSession}
      onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
      onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
      onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
      onOpenWorkflowRun={handleOpenWorkflowRun}
      onRefreshGit={handleRefreshGit}
      onBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
      onBrowserUrlChange={handleBrowserUrlChange}
      onBrowserPageMetadataChange={handleBrowserPageMetadataChange}
      onSelectGitSource={setGitSelectedSourceId}
    />
  );
  const sidePanePanel = renderSidePanePanel();
  const hasUpdateStatusButton =
    updateReadyVersion !== null ||
    updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded";
  // Draft 之前维护一套独立轻量 header，导致 side pane、caption 安全区和拖拽入口
  // 与 Task Header 分叉。桌面端统一复用 WorkspaceHeader，只由 variant 裁剪 task 专属内容。
  const isMainViewHeaderEligible =
    workspaceMainView !== "automations" && workspaceMainView !== "plugin-store";
  // 渲染与否只看主视图，绝不看侧栏显隐。
  //
  // Header 在正文流里占 48px，出现/消失会整体顶动正文。旧判据是
  // `isDesktop || activeTaskId !== null || !isSidebarVisible`：桌面恒真、任务态被
  // activeTaskId 兜住，唯独网页版草稿态（新建、无活动任务）退化成 !isSidebarVisible，
  // 于是开关抽屉时 Header 整条增删、正文被顶起又落回 48px —— 任务态不跳，所以只有
  // 「新建」视图能看出纵向位移。判定已抽进纯函数，签名里不带任何侧栏/宽度入参。
  const shouldRenderWorkspaceHeader = shouldRenderWorkspaceHeaderForMainView({
    isMainViewHeaderEligible,
  });

  // 网页入口始终住在浮层，不搬进顶栏。收起时只留空槽，把标题推开以免叠住按钮。
  // 空槽宽度按浮层实际按钮数计算（侧栏切换 + 收起态恒可见的新建任务 + 有更新才出现的
  // 更新入口），不再固定 104px 死占；更新入口的有无与浮层里的 UpdateStatusButton
  // 同源（hasUpdateStatusButton），两侧宽度不会错位。
  const webNavigationActions =
    shouldMoveWebNavigationActionsIntoViewHeader() ||
    !shouldReserveWebNavigationActionsSlot({
      isDesktop: Boolean(isDesktop),
      isSidebarVisible,
    }) ? undefined : (
      <div
        className={resolveWebNavigationActionsSlotClassName({
          showNewTaskButton: showTopOverlayNewTaskButton,
          hasUpdateStatusButton,
        })}
        aria-hidden="true"
      />
    );
  // ErrorBoundary resetKeys 的数组如果每次 render 都重新创建，
  // 即使 workspace/task 没变化也会在 React DevTools Components 轨道里持续表现为子树 props 变化。
  const workspaceOnlyResetKeys = useMemo(() => [workspaceKey], [workspaceKey]);
  const workspaceDraftResetKeys = useMemo(
    () => [workspaceKey, activeTaskId ?? "draft"],
    [workspaceKey, activeTaskId],
  );

  return (
    <DesktopWindowFrame
      title={`YCode / ${getPathLeaf(workspaceAbsPath)}`}
      showHeader
      isDesktop={isDesktop}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
      headerTestId={TID_APP_HEADER}
    >
      <div
        ref={workspaceShellRef}
        data-workspace-shell="true"
        style={workspaceShellSplitStyle}
        className={cn(
          "relative flex h-full min-h-0 w-full overflow-hidden",
          // 窗口原生 resize 时，外层 react-resizable-panels 会把每一帧
          // 都写进 layout store，连带侧栏 tooltip/menu 子树反复 commit。这里改成
          // CSS 变量驱动的专用 split，普通窗口 resize 只走浏览器布局，不触发 React 状态。
        )}
      >
        <div
          ref={workspaceSidebarPanelElementRef}
          data-panel=""
          data-workspace-sidebar-panel="true"
          data-workspace-sidebar-presentation={sidebarPresentation}
          id="sidebar"
          className={cn(
            "w-[var(--workspace-sidebar-panel-width)] overflow-hidden duration-200 ease-out",
            resolveWorkspaceSidebarPanelSurfaceClassName({
              presentation: sidebarPresentation,
            }),
            resolveWorkspaceSidebarPanelPositionClassName({
              presentation: sidebarPresentation,
              isSidebarVisible: isSidebarPanelVisible,
            }),
            sidebarPresentation === "drawer"
              ? // 抽屉宽度恒定，显隐只走 translate-x（transition-transform 已随位移类
                // 一起收在 resolveWorkspaceSidebarPanelPositionClassName 里，与位移同源）：
                // 宽度一起归零会让展开变成挤压动画。
                "max-w-[85vw]"
              : cn(
                  "max-w-[50%] transition-[width,opacity] data-[workspace-sidebar-resizing=true]:transition-opacity",
                  // 拖动侧栏宽度时如果继续过渡 width，会让指针移动和实际宽度之间产生滞后。
                  // 拖拽 active 通过 DOM 标记切 transition，避免 pointerdown/up 为了切 class 重渲染整棵 workspace。
                  isSidebarPanelVisible ? "opacity-100" : "pointer-events-none opacity-0",
                ),
          )}
        >
          <aside
            ref={sidebarContainerRef}
            // 这里不能加 select-none：它是会话列表滚动容器的祖先，而 user-select 在 WebKit 里
            // 由命中测试层自己处理，罩住列表会让 iOS 在该子树内拒绝发起原生滚动——现象是侧栏
            // 第一次滑动永远没反应、第二次才滚，且事件日志里查不到任何 JS 痕迹。
            // 禁止选区只做在侧栏固定 chrome 上，规则见 docs/specs/workspace-shell-responsive-layout.md。
            className="h-full overflow-hidden"
            aria-hidden={!isSidebarPanelVisible}
          >
            <ScopedErrorBoundary
              scope="workspace-sidebar"
              resetKeys={workspaceOnlyResetKeys}
              variant="panel"
              className="h-full"
            >
              {/* session workbench groups：桌面和普通 web app 可分屏，手机远控与窄视口抽屉形态
                  不启用（约定见 splitPaneEntryContext.tsx，此前 enabled 写成字面量 true 未兑现）。
                  规则见 docs/specs/workspace-shell-responsive-layout.md。 */}
              <V4SplitPaneEntryProvider
                enabled={sidebarPresentation === "inline"}
                canOpenSession={canOpenSessionInSplitPane}
                onOpenSession={handleOpenSessionInSplitPane}
              >
                <WorkflowRunOpenProvider onOpenRun={handleOpenSidebarWorkflowRun}>
                  <WorkspaceSidebar
                    workspacePath={workspaceAbsPath}
                    workspaceRemoteSessionId={workspaceRemoteSessionId}
                    onSelectTask={handleSelectTaskFromSidebar}
                    onStartDraftInWorkspace={handleCreateProjectDraftFromSidebar}
                    onOpenBrowserUrl={handleOpenBrowserUrl}
                    onCreateTask={handleCreateTaskFromSidebar}
                    onCreateConversationTask={
                      onCreateConversationTask ?? handleCreateTaskFromSidebar
                    }
                    onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
                    onOpenRemoteWorkspace={onOpenRemoteWorkspace}
                    theme={theme}
                    onConnectRemote={onConnectRemote}
                    onSelectRemoteProject={onSelectRemoteProject}
                    onCancelRemoteProject={onCancelRemoteProject}
                    onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
                    reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                    remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                    reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                      reconnectingRemoteWorkspaceLogsByWorkspaceKey
                    }
                    onLogout={onLogout}
                    isDesktop={isDesktop}
                    isMacDesktop={isMacDesktop}
                    isWindowsDesktop={isWindowsDesktop}
                    isSidebarVisible={isSidebarVisible}
                    onToggleSidebar={handleToggleSidebar}
                    toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
                    canGoBack={canPrimaryNavigationBack}
                    canGoForward={canTaskNavForward}
                    onGoBack={primaryNavigationBack}
                    onGoForward={handleTaskNavForward}
                    goBackShortcutLabel={goBackShortcutLabel}
                    goForwardShortcutLabel={goForwardShortcutLabel}
                    onOpenCommandCenter={handleOpenCommandCenterFromSidebar}
                    onOpenAutomations={handleOpenAutomationsFromSidebar}
                    automationsActive={workspaceMainView === "automations"}
                    onOpenPluginStore={handleOpenPluginStoreFromSidebar}
                    pluginStoreActive={workspaceMainView === "plugin-store"}
                    shellPrimaryView={shellPrimaryView}
                    settingsNavigation={
                      <div
                        ref={handleSettingsNavSlotRef}
                        className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
                      />
                    }
                    onShowTasks={onShowTasks}
                    onShowFiles={onShowFiles}
                    onShowSettings={onShowSettings}
                    onOpenedWorkbenchFile={collapseSidebarAfterNavigation}
                  />
                </WorkflowRunOpenProvider>
              </V4SplitPaneEntryProvider>
            </ScopedErrorBoundary>
          </aside>
        </div>

        {/* 窄屏抽屉的遮罩：抽屉形态下常驻挂载，显隐走 200ms 透明度过渡，与抽屉的
            translate 滑动同节奏，不再瞬切。点击即收起侧栏。层级低于抽屉，也低于顶部
            浮层，所以浮层里的切换按钮在抽屉展开时仍然可点。收起态 inert + 透明 +
            pointer-events-none：不可聚焦、不参与命中测试。 */}
        {shouldRenderWorkspaceSidebarBackdrop({
          presentation: sidebarPresentation,
        }) ? (
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: "workspaceSidebar.closeDrawer",
            })}
            aria-hidden={!isSidebarPanelVisible}
            inert={!isSidebarPanelVisible}
            data-testid="workspace-sidebar-backdrop"
            onClick={handleToggleSidebar}
            className={cn(
              "absolute inset-0 m-0 cursor-default border-0 bg-black/40 p-0",
              WORKSPACE_SIDEBAR_BACKDROP_Z_CLASS,
              resolveWorkspaceOverlayBackdropClassName({
                isVisible: isSidebarPanelVisible,
              }),
            )}
          />
        ) : null}

        {shouldRenderWorkspaceSidebarResizeHandle({
          presentation: sidebarPresentation,
          isSidebarVisible: isSidebarPanelVisible,
        }) ? (
          <div
            role="separator"
            tabIndex={0}
            aria-controls="sidebar"
            aria-label={workspaceSidebarResizeLabel}
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_SIDEBAR_MIN_WIDTH_PX}
            aria-valuenow={Math.round(workspaceSidebarPanelWidthPx)}
            data-testid="resizable-handle"
            onKeyDown={handleWorkspaceSidebarResizeKeyDown}
            onPointerCancel={(event) => finishWorkspaceSidebarResize(event, true)}
            onPointerDown={handleWorkspaceSidebarResizeStart}
            onPointerMove={handleWorkspaceSidebarResizeMove}
            onPointerUp={(event) => finishWorkspaceSidebarResize(event)}
            className={cn(
              "group/handle relative z-10 flex h-full w-1 shrink-0 touch-none cursor-ew-resize items-center justify-center bg-transparent outline-none [app-region:no-drag] focus:outline-none focus-visible:ring-0",
              "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius)] after:w-0.5",
              "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100 [[data-workspace-sidebar-resizing=true]_&]:after:opacity-100",
              hasDesktopPanelInset && "after:inset-y-[var(--workspace-resize-handle-inset)]",
            )}
          />
        ) : null}
        {/* 右侧主工作区：上方 header，下面左侧会话+终端，右侧共享 browser/code-viewer 槽位 */}
        <div
          data-panel=""
          id="content"
          className={cn(
            "flex flex-1 flex-col",
            resolveWorkspaceContentMinWidthClassName({
              presentation: sidebarPresentation,
            }),
            resolveWorkspaceContentIsolationClassName({
              presentation: sidebarPresentation,
            }),
            resolveWorkspaceContentPaddingClassName({
              presentation: sidebarPresentation,
              hasDesktopPanelInset,
            }),
          )}
        >
          {
            hasDesktopPanelInset && (
              <div className="h-1 w-full [app-region:drag]" />
            ) /* 修复 macOS 顶部窗口控制按钮被 header 遮挡无法点击的问题 */
          }
          <div className="relative isolate flex min-h-0 flex-1 flex-col">
            {shellPrimaryView === "settings" ? (
              <div className={resolveWorkspaceShellSettingsSurfaceClassName()}>
                <SettingsPage
                  layout="embedded"
                  navigationPortalTarget={settingsNavSlot}
                  isDesktop={isDesktop}
                  isMacDesktop={isMacDesktop}
                  isWindowsDesktop={isWindowsDesktop}
                  onBack={onShowTasks}
                  onCreateTask={handleCreateTaskInChat}
                  onOpenWorkspace={onOpenWorkspace}
                  allowOpenWorkspace={allowOpenWorkspace}
                  onLogout={onLogout}
                  onSectionNavigated={collapseSidebarAfterNavigation}
                  initialNavigationPosition={
                    webRoutePosition?.kind === "settings" ? webRoutePosition : undefined
                  }
                  onNavigationPositionChange={(position, options) => {
                    if (webRoutePosition?.kind === "settings") {
                      onWebRoutePositionChange(
                        {
                          kind: "settings",
                          ...position,
                        },
                        options,
                      );
                    }
                  }}
                  onShowTasks={onShowTasks}
                  onShowFiles={onShowFiles}
                  tasksTabEnabled
                />
              </div>
            ) : null}
            <div
              className={resolveWorkspaceShellFilesSurfaceClassName({
                isFilesPrimaryView: shellPrimaryView === "files",
              })}
              aria-hidden={shellPrimaryView !== "files"}
              inert={shellPrimaryView !== "files" ? true : undefined}
            >
              <ScopedErrorBoundary
                scope="files-workbench"
                resetKeys={workspaceOnlyResetKeys}
                variant="panel"
                className="h-full"
              >
                <FilesWorkbenchSurface
                  isActiveView={shellPrimaryView === "files"}
                  isDesktop={Boolean(isDesktop)}
                />
              </ScopedErrorBoundary>
            </div>
            <div
              className={resolveWorkspaceShellTasksKeepaliveClassName({
                isSettingsPrimaryView: shellPrimaryView === "settings",
                isFilesPrimaryView: shellPrimaryView === "files",
              })}
              aria-hidden={shellPrimaryView !== "tasks"}
              inert={shellPrimaryView !== "tasks" ? true : undefined}
            >
              <ResizablePanelGroup
                layoutId="workspace-body-layout"
                panelIds={WORKSPACE_BODY_PANEL_IDS}
                className="min-h-0 flex-1"
              >
                <ResizablePanel
                  id="conversation-column"
                  minSize="35%"
                  defaultSize={isSidePaneVisible ? "52%" : undefined}
                >
                  <ResizablePanelGroup
                    orientation="vertical"
                    layoutId="workspace-conversation-column-layout"
                    panelIds={WORKSPACE_CONVERSATION_PANEL_IDS}
                    className="h-full min-h-0"
                  >
                    <ResizablePanel
                      id="conversation"
                      elementRef={conversationPanelElementRef}
                      minSize="35%"
                    >
                      <section
                        data-workspace-conversation-frame="true"
                        className={cn(
                          "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background",
                          resolveWorkspaceShellSplitPanelFrameClassName({
                            ...workspaceShellWindowChrome,
                            isPairedWithSiblingPanel: isSidePaneVisible,
                          }),
                          isTerminalVisible && "rounded-b-[var(--workspace-panel-radius)] border-b",
                        )}
                      >
                        {shouldRenderWorkspaceHeader ? (
                          <ScopedErrorBoundary
                            scope="workspace-header"
                            resetKeys={workspaceOnlyResetKeys}
                            variant="compact"
                            className="border-b"
                          >
                            <WorkspaceHeader
                              reserveWindowControls={!isSidePaneVisible}
                              variant={activeTaskId === null ? "draft" : "task"}
                              draftDropTargetController={
                                activeTaskId === null ? draftHeaderDropTargetController : undefined
                              }
                              readOnlyReason={workspaceReadOnlyReason}
                              workspaceAbsPath={workspaceAbsPath}
                              remoteSessionId={workspaceRemoteSessionId}
                              workspaceIdentity={workspaceIdentity}
                              remoteTarget={workspaceRemoteTarget}
                              localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                              projectName={projectName}
                              activeTaskTitle={activeTaskTitle}
                              activeTaskChangeSummary={activeTaskChangeSummary}
                              hasUpdateReady={hasUpdateStatusButton}
                              activeTaskId={activeTaskId}
                              user={user}
                              activeTraceId={activeTraceId}
                              activeSessionId={activeSessionId}
                              activeTaskProvider={activeTaskProvider}
                              resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                              sessionLogPath={taskSessionFile.path}
                              nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                              nativeSessionLogPath={taskNativeSessionLogFile.path}
                              nativeSessionLogExists={taskNativeSessionLogFile.exists}
                              nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                              workspaceHeaderState={workspaceShellZCodeState}
                              gitSummary={gitState.summary}
                              gitDirtyFileCount={gitDirtyFileCount}
                              isMacDesktop={isMacDesktop}
                              isMacFullscreen={isMacFullscreen}
                              isWindowsDesktop={isWindowsDesktop}
                              windowsWindowControlsRightPaddingPx={
                                windowsWindowControlsRightPaddingPx
                              }
                              isDesktop={isDesktop}
                              webNavigationActions={webNavigationActions}
                              // 接上窄视口判定：WorkspaceHeader 里配 max-md 的收窄与
                              // hideMobileUnsupportedActions 此前从没有调用方赋值，一直是死分支。
                              simplifyForNarrowRemote={isNarrowViewport}
                              isSidebarVisible={isSidebarVisible}
                              isTerminalOpen={isTerminalOpen}
                              isSidePaneOpen={isSidePaneOpen}
                              onRefreshGit={handleRefreshGit}
                              onToggleTerminal={handleToggleTerminal}
                              onToggleBrowser={handleToggleBrowser}
                              onToggleSidePane={handleToggleSidePane}
                              toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                              onReloadSession={handleReloadSession}
                              reloadSessionDisabled={workspaceSessionActionDisabled}
                              reloadSessionPending={reloadSessionPending}
                              onCreateTask={handleCreateTaskInChat}
                              onOpenWorkspace={onOpenWorkspace}
                              allowOpenWorkspace={allowOpenWorkspace}
                            />
                          </ScopedErrorBoundary>
                        ) : null}
                        <div className="min-h-0 flex-1 overflow-hidden">
                          {workspaceMainView === "automations" ? (
                            <main
                              id={AUTOMATIONS_TOAST_ANCHOR_ID}
                              className="flex h-full min-h-0 flex-1 flex-col bg-background"
                            >
                              <AutomationsMainBreadcrumbFrame
                                isDesktop={Boolean(isDesktop)}
                                actions={webNavigationActions}
                                sectionLabel={intl.formatMessage({
                                  id: "settings.automations.title",
                                })}
                                ariaLabel={intl.formatMessage({
                                  id: "automations.breadcrumbLabel",
                                })}
                              >
                                <div
                                  // 不同 Automations tab 的内容高度不同，滚动条出现/消失会改变
                                  // mx-auto 内容列的可用宽度，造成整页左右弹动；预留稳定槽位保持居中基准不变。
                                  className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                                >
                                  <ScopedErrorBoundary
                                    scope="automations-main"
                                    resetKeys={workspaceOnlyResetKeys}
                                    variant="panel"
                                    className="min-h-full"
                                  >
                                    <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                                      <AutomationsSection
                                        workspacePath={workspaceAbsPath}
                                        workspaceIdentity={workspaceIdentity}
                                        onCreateViaChat={handleCreateAutomationInChat}
                                        onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                                        onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                                        onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                                        openAutomationId={openAutomationId}
                                        openAutomationTab={openAutomationTab}
                                        onOpenAutomationConsumed={onOpenAutomationConsumed}
                                        onOpenSession={({
                                          sessionId,
                                          workspacePath,
                                          workspaceIdentity,
                                        }) =>
                                          handleSelectTaskInChat(
                                            workspacePath,
                                            sessionId,
                                            workspaceIdentity,
                                          )
                                        }
                                      />
                                    </div>
                                  </ScopedErrorBoundary>
                                </div>
                              </AutomationsMainBreadcrumbFrame>
                            </main>
                          ) : workspaceMainView === "plugin-store" ? (
                            <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
                              <AutomationsMainBreadcrumbFrame
                                isDesktop={Boolean(isDesktop)}
                                actions={webNavigationActions}
                                sectionLabel={intl.formatMessage({
                                  id: "workspace.openPluginsSettings",
                                })}
                                ariaLabel={intl.formatMessage({
                                  id: "settings.breadcrumbLabel",
                                })}
                              >
                                <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                                  <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                                    <PluginStorePage
                                      key={`plugin-store:${pluginStoreOpenVersion}`}
                                      workspacePath={workspaceAbsPath}
                                      workspaceIdentity={workspaceIdentity}
                                      initialPluginId={
                                        webRoutePosition?.kind === "plugin-store"
                                          ? webRoutePosition.pluginId
                                          : undefined
                                      }
                                      onPluginIdChange={(pluginId, options) => {
                                        if (webRoutePosition?.kind === "plugin-store") {
                                          onWebRoutePositionChange(
                                            {
                                              kind: "plugin-store",
                                              ...(pluginId ? { pluginId } : {}),
                                            },
                                            options,
                                          );
                                        }
                                      }}
                                      onCreateTask={handleCreateTaskInChat}
                                      onManageInstalled={handleManageInstalledPlugins}
                                    />
                                  </div>
                                </div>
                              </AutomationsMainBreadcrumbFrame>
                            </main>
                          ) : (
                            <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                              {renderChatFindDialog()}
                              <ScopedErrorBoundary
                                scope="workspace-chat"
                                resetKeys={workspaceDraftResetKeys}
                                variant="panel"
                                className="h-full"
                              >
                                {/* pane 绑定必须用原始选择态 activeTaskId，
                                  不能用 meta 派生的 activeSessionId——v4 createSession 刚建的会话
                                  不在 taskListCache/optimistic 缓存里，meta 解析为 null 会让 pane
                                  永远停在 draft。v4 语义下 sessionId ≡ taskId，meta 只服务 Header 显示。
                                  桌面主区升级为分屏宿主（Layout/Focus 两层）；primary pane
                                  绑定语义与 testid 契约（paneId=workspace-main）不变。 */}
                                <V4WorkspaceChatArea
                                  readOnly={Boolean(workspaceReadOnlyReason)}
                                  foregroundEnabled={isWorkspaceVisible}
                                  workspacePath={workspaceAbsPath}
                                  workspaceIdentity={workspaceIdentity}
                                  isDesktop={isDesktop === true}
                                  remoteSessionId={workspaceRemoteSessionId}
                                  sessionId={activeTaskId}
                                  activeSelectionSideChatSessionId={
                                    activeSelectionSideChatSessionId
                                  }
                                  provider={activeTaskProvider ?? undefined}
                                  onSessionCreated={handleV4SessionCreated}
                                  onSessionDeleted={handleV4SessionDeleted}
                                  draftComposerHeader={draftComposerHeader}
                                  agentWorktreeIntent={
                                    draftAgentWorktreeBranch
                                      ? { branch: draftAgentWorktreeBranch }
                                      : null
                                  }
                                  onAgentWorktreeIntentConsumed={handleDraftAgentWorktreeConsumed}
                                  onPrimaryDraftDropTargetControllerChange={
                                    setDraftHeaderDropTargetController
                                  }
                                  gitSummary={gitState.summary}
                                  gitDirtyFileCount={gitDirtyFileCount}
                                  activeTaskChangeSummary={activeTaskChangeSummary}
                                  gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                                  gitWorktreeChangeSummary={gitWorktreeChangeSummary}
                                  summaryPanelVariantOverride={summaryPanelVariantOverride}
                                  onSummaryPanelVariantOverrideChange={
                                    onSummaryPanelVariantOverrideChange
                                  }
                                  onRefreshGit={handleRefreshGit}
                                  onOpenGitReview={handleOpenGitReview}
                                  onPaneActiveSessionChange={handlePaneActiveSessionChange}
                                  onOpenBrowserUrl={handleOpenBrowserUrl}
                                  onOpenAutomationsMain={handleOpenAutomations}
                                  onOpenCodeViewer={handleOpenCodeViewer}
                                  onAutoOpenAssistantPptx={
                                    isDesktop ? handleAutoOpenAssistantPptx : undefined
                                  }
                                  onOpenBackgroundBash={handleOpenBackgroundBash}
                                  onOpenSandboxConsole={handleOpenSandboxConsole}
                                  onOpenSubagentSession={handleOpenSubagentSession}
                                  onOpenSubagentDirectory={handleOpenSubagentDirectory}
                                  onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                                  onOpenSelectionSideChat={handleOpenSelectionSideChat}
                                  onOpenPlanDetail={handleOpenPlanDetail}
                                  onOpenPlanDirectory={handleOpenPlanDirectory}
                                  onOpenWorkflowRun={handleOpenWorkflowRun}
                                  onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                                  onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                                  onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                                  onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                                  onOpenFileLink={handleOpenMarkdownFileLink}
                                  onOpenSessionCitation={handleOpenSessionCitation}
                                  conversationFindQuery={conversationFindQuery}
                                  conversationFindActiveIndex={conversationFindActiveIndex}
                                  conversationFindNavigationRequestId={
                                    conversationFindNavigationRequestId
                                  }
                                  onConversationFindMatchStateChange={
                                    onConversationFindMatchStateChange
                                  }
                                  searchResultHighlightRequest={activeSearchResultHighlightRequest}
                                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                                />
                              </ScopedErrorBoundary>
                            </main>
                          )}
                        </div>
                      </section>
                    </ResizablePanel>
                    {workspaceMainView !== "automations" && workspaceMainView !== "plugin-store" ? (
                      <AnimatedTerminalPanel
                        frameClassName={cn(
                          resolveWorkspaceShellSplitPanelFrameClassName({
                            ...workspaceShellWindowChrome,
                            isPairedWithSiblingPanel: isSidePaneVisible,
                          }),
                          "rounded-t-[var(--workspace-panel-radius)] border-t",
                        )}
                        services={services}
                        workspaceAbsPath={workspaceAbsPath}
                        workspaceIdentity={workspaceIdentity}
                        openWorkspaceKeys={openWorkspaceKeys}
                        isVisible={isTerminalVisible}
                        isWindowsDesktop={isWindowsDesktop}
                        panelRef={terminalPanelRef}
                        panelElementRef={terminalPanelElementRef}
                        onClose={() => setIsTerminalOpen(false)}
                        onOpenBrowserUrl={handleOpenBrowserUrl}
                      />
                    ) : null}
                  </ResizablePanelGroup>
                </ResizablePanel>
                {/* Browser Guest Host 必须与主视图路由解耦，避免 automations/plugin
                    切换时卸载 Guest；截图请求期间由上层临时展开真实面板承载可合成的 WebContents。 */}
                {/* 窄屏下 Side Pane 改成右侧覆盖层，靠包裹层切形态而不是挪动 React 树位置：
                Panel/Separator 靠 context 向 Group 注册，不依赖 DOM 父子关系，
                所以宽屏直挂、窄屏包覆盖层都不会让 Browser Guest 重挂载；
                远端浏览器会话在跨断点缩放时不被销毁。 */}
                {/* 但宽屏下手柄与面板必须是 Group 的直接 DOM 子节点：库的拖拽命中区只枚举
                Group 根元素的 children，中间隔一层 display:contents 的 div 也算不出
                命中区（它只对布局透明，不改变 DOM 父子关系），右边栏会拖不动。
                因此宽屏不渲染包裹层、直接挂 sidePanePanel，窄屏才包覆盖层。 */}
                {/* 遮罩同样在抽屉形态下常驻挂载，显隐走 200ms 透明度过渡，与包裹层的
                right 滑动同节奏；收起态 inert + 透明 + pointer-events-none，
                不吃会话列的指针与触摸事件。 */}
                {shouldRenderWorkspaceSidePaneBackdrop({
                  presentation: sidebarPresentation,
                }) ? (
                  <button
                    type="button"
                    aria-label={intl.formatMessage({
                      id: "workspaceSidePane.closePanel",
                    })}
                    aria-hidden={!isSidePaneBackdropVisible}
                    inert={!isSidePaneBackdropVisible}
                    data-testid="workspace-side-pane-backdrop"
                    onClick={handleToggleSidePane}
                    className={cn(
                      "absolute inset-0 m-0 cursor-default border-0 bg-black/40 p-0",
                      WORKSPACE_SIDE_PANE_BACKDROP_Z_CLASS,
                      resolveWorkspaceOverlayBackdropClassName({
                        isVisible: isSidePaneBackdropVisible,
                      }),
                    )}
                  />
                ) : null}
                {/* 包裹层在面板收起时必须惰性：它的盒子尺寸与面板是否收起无关，不置为
                pointer-events-none 就会变成一块 92vw 宽的透明遮罩，吃掉会话列的
                指针与触摸事件（消息列表划不动）。宽屏下没有包裹层，面板直挂分栏组。 */}
                {shouldWrapAnimatedSidePanePanel({
                  presentation: sidebarPresentation,
                }) ? (
                  <div
                    data-workspace-side-pane-wrapper="true"
                    className={resolveWorkspaceSidePaneWrapperClassName({
                      presentation: sidebarPresentation,
                      isSidePaneVisible,
                    })}
                  >
                    {sidePanePanel}
                  </div>
                ) : (
                  sidePanePanel
                )}
              </ResizablePanelGroup>
            </div>
          </div>
        </div>
        <ScopedErrorBoundary
          scope="desktop-top-overlay"
          resetKeys={workspaceOnlyResetKeys}
          variant="silent"
        >
          {/* 窄屏网页下右抽屉打开时隐藏顶部浮层：抽屉包裹层 z-[31] 被关进 #content 的
              isolate 层叠上下文，根上输给浮层 z-20，浮层会压在抽屉 Tab 栏（h-12）上；
              右抽屉没有主 Header 那样的等宽空槽承接，只能藏浮层。桌面端不藏：
              桌面抽屉内容自带 pt-12 避让窗控留白，与浮层错开。左侧栏不受影响：
              这里只藏右抽屉打开时的浮层入口，左侧抽屉的遮罩/面板/关闭链路原样保留，
              右抽屉可经自身遮罩与关闭按钮关闭，关闭后浮层即恢复。 */}
          {shouldHideDesktopTopOverlayForSidePaneDrawer({
            isDesktop: Boolean(isDesktop),
            presentation: sidebarPresentation,
            isSidePaneBackdropVisible,
          }) ? null : (
            <DesktopTopOverlay
              newTaskDisabledReason={workspaceReadOnlyReason}
              workspaceAbsPath={workspaceAbsPath}
              isMacDesktop={isMacDesktop}
              isMacFullscreen={isMacFullscreen}
              macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
              windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
              isWindowsDesktop={isWindowsDesktop}
              isDesktop={isDesktop}
              isSidebarVisible={isSidebarVisible}
              updateReadyVersion={updateReadyVersion}
              updateState={updateState}
              toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
              newTaskShortcutLabel={newTaskShortcutLabel}
              showNewTaskButton={showTopOverlayNewTaskButton}
              appLogoUrl={appLogoUrl}
              platform={platform}
              onToggleSidebar={handleToggleSidebar}
              onCreateTask={handleCreateTaskInChat}
            />
          )}
        </ScopedErrorBoundary>
      </div>
    </DesktopWindowFrame>
  );
});
