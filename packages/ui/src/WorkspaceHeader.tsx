import type {
  ZCodeProvider,
  ZCodeTaskMeta,
  ZCodeTaskChangeSummary,
  EditorInfo,
  GitRepositorySummary,
  RemoteTarget,
  UserInfo,
} from "@zcode/shared";
import { useState, type ReactNode } from "react";
import { TID_WORKSPACE_HEADER } from "@zcode/shared";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { cn } from "@/components/lib/utils.js";
import {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderState,
  WorkspaceHeaderTitleSection,
} from "@/WorkspaceHeaderSections.js";
import type { WorkspaceHeaderVariant } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeader({
  variant = "task",

  draftDropTargetController,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  remoteTarget,
  localWorkspacePath,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary,
  hasUpdateReady,
  activeTaskId,
  user,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  sessionLogPath,
  nativeSessionLogProvider,
  nativeSessionLogPath,
  nativeSessionLogExists,
  nativeSessionLogLoading,
  workspaceHeaderState,
  gitSummary,
  gitDirtyFileCount,
  isMacDesktop,
  isMacFullscreen,
  isWindowsDesktop,

  isDesktop,
  webNavigationActions,
  simplifyForNarrowRemote = false,
  isSidebarVisible,
  isTerminalOpen,
  isSidePaneOpen,
  onRefreshGit,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onReloadSession,
  reloadSessionDisabled,
  reloadSessionPending,
}: {
  variant?: WorkspaceHeaderVariant;
  draftDropTargetController?: ConversationDropTargetController | null;
  readOnlyReason?: string;
  workspaceAbsPath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  remoteTarget?: RemoteTarget;
  localWorkspacePath?: string;
  projectName: string;
  activeTaskTitle: string;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  hasUpdateReady: boolean;
  activeTaskId: string | null;
  user?: UserInfo | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  sessionLogPath: string | null;
  nativeSessionLogProvider: ZCodeProvider | null;
  nativeSessionLogPath: string | null;
  nativeSessionLogExists: boolean;
  nativeSessionLogLoading: boolean;
  workspaceHeaderState: WorkspaceHeaderState;
  gitSummary: GitRepositorySummary;
  gitDirtyFileCount: number;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  reserveWindowControls?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  isDesktop?: boolean;
  /** 网页版侧栏收起时融入 header 左侧的全局入口（侧栏切换/新建任务/更新），桌面与侧栏展开时不传。 */
  webNavigationActions?: ReactNode;
  simplifyForNarrowRemote?: boolean;
  isSidebarVisible: boolean;
  isTerminalOpen: boolean;
  isSidePaneOpen: boolean;
  onRefreshGit: () => void;
  onToggleTerminal: () => void;
  onToggleBrowser: () => void;
  onToggleSidePane: () => void;
  toggleSidePaneShortcutLabel?: string;
  onReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => void | Promise<void>;
  reloadSessionDisabled?: boolean;
  reloadSessionPending?: boolean;
  onCreateTask: () => void;
  onOpenWorkspace: () => void;
  allowOpenWorkspace?: boolean;
}) {
  const [selectedEditor, setSelectedEditor] = useState<EditorInfo | null>(null);
  // 这段留白有两个来源：桌面端给原生窗控让位；网页版给悬浮的全局入口让位。
  // 网页版入口只在侧栏展开时留在浮层里，此时浮层位于侧栏上方、压不到主区 header；
  // 侧栏收起时入口已经搬进 header 自身，也就不需要再为自己留白。
  const shouldOffsetHeaderForWindowControls = !isSidebarVisible && Boolean(isDesktop);
  // Linux 与 Windows 共用内联窗控，不再预留旧悬浮窗控的标题栏区域。
  const usesInlineWindowControls = Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop));

  let headerWindowControlsPaddingClass: string | false = false;
  if (shouldOffsetHeaderForWindowControls) {
    if (isMacDesktop) {
      if (hasUpdateReady) {
        headerWindowControlsPaddingClass = isMacFullscreen ? "pl-48" : "pl-66";
      } else {
        headerWindowControlsPaddingClass = isMacFullscreen ? "pl-38" : "pl-58";
      }
    } else {
      headerWindowControlsPaddingClass = hasUpdateReady ? "pl-44" : "pl-38";
    }
  }

  // 左区标题抽成变量：网页版侧栏收起时要把全局入口和它包进同一个 flex 容器，桌面分支保持原 DOM。
  const titleSection =
    variant === "task" ? (
      <WorkspaceHeaderTitleSection
        variant={variant}
        readOnlyReason={readOnlyReason}
        workspaceAbsPath={workspaceAbsPath}
        remoteSessionId={remoteSessionId}
        workspaceIdentity={workspaceIdentity}
        remoteTarget={remoteTarget}
        localWorkspacePath={localWorkspacePath}
        projectName={projectName}
        activeTaskTitle={activeTaskTitle}
        activeTaskChangeSummary={activeTaskChangeSummary}
        activeTaskId={activeTaskId}
        activeTraceId={activeTraceId}
        activeSessionId={activeSessionId}
        activeTaskProvider={activeTaskProvider}
        resolvedActiveTaskMeta={resolvedActiveTaskMeta}
        gitSummary={gitSummary}
        gitDirtyFileCount={gitDirtyFileCount}
        sessionLogPath={sessionLogPath}
        nativeSessionLogProvider={nativeSessionLogProvider}
        nativeSessionLogPath={nativeSessionLogPath}
        nativeSessionLogExists={nativeSessionLogExists}
        nativeSessionLogLoading={nativeSessionLogLoading}
        workspaceHeaderState={workspaceHeaderState}
        isMacDesktop={isMacDesktop}
        isMacFullscreen={isMacFullscreen}
        isWindowsDesktop={isWindowsDesktop}
        simplifyForNarrowRemote={simplifyForNarrowRemote}
        selectedEditor={selectedEditor}
        onReloadSession={onReloadSession}
        reloadSessionDisabled={reloadSessionDisabled}
        reloadSessionPending={reloadSessionPending}
        onRefreshGit={onRefreshGit}
      />
    ) : null;

  return (
    <header
      data-testid={TID_WORKSPACE_HEADER}
      data-workspace-header-variant={variant}
      className={cn(
        "@container/workspace-header relative flex w-full shrink-0 h-12 border-b",
        variant === "draft" ? "border-transparent" : "border-border/50",
      )}
    >
      {variant === "draft" && draftDropTargetController?.active ? (
        <div
          className="absolute inset-0 z-40 bg-accent/55 backdrop-blur-sm pointer-events-auto [app-region:no-drag]"
          data-testid="new-task-draft-drop-mask"
          onDragOver={draftDropTargetController.onDragOver}
          onDragLeave={draftDropTargetController.onDragLeave}
          onDrop={draftDropTargetController.onDrop}
        />
      ) : null}
      <div
        className={cn(
          // 大会话 resize trace 显示 titlebar padding 动画层会触发 scrollbar-color 非合成动画；
          // 明确限定 transition-property 为 padding，避免 duration-300 退回默认 all。
          "flex h-12 flex-1 min-w-0 items-center justify-between gap-2 overflow-hidden p-2 [app-region:drag] transition-[padding] duration-300",
          // 旧 caption 菜单移除后不能继续清零右边距，否则终端按钮会贴住面板边框。
          headerWindowControlsPaddingClass,
        )}
      >
        {webNavigationActions ? (
          // 网页版侧栏收起：全局入口（侧栏切换/新建任务/更新）与标题同处左区，
          // 与标题之间留出正常间距；入口组自带 shrink-0，不会被标题挤压。
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {webNavigationActions}
            {titleSection}
          </div>
        ) : titleSection ? (
          titleSection
        ) : (
          <div className="min-w-0 flex-1" aria-hidden="true" />
        )}
        <WorkspaceHeaderActionSection
          variant={variant}
          activeTaskId={activeTaskId}
          user={user}
          readOnlyReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          remoteTarget={remoteTarget}
          isDesktop={isDesktop}
          isTerminalOpen={isTerminalOpen}
          isSidePaneOpen={isSidePaneOpen}
          onToggleTerminal={onToggleTerminal}
          onToggleSidePane={onToggleSidePane}
          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
          simplifyForNarrowRemote={simplifyForNarrowRemote}
          hideHelpMenu={false}
          showWindowControls={usesInlineWindowControls}
          // 面板操作按钮沿用 macOS 紧凑样式，Windows/Linux 窗控跟随最右侧 Header。
          onSelectedEditorChange={setSelectedEditor}
        />
      </div>
    </header>
  );
}
