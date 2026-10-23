import {
  TID_WEB_TOP_BAR,
  TID_WEB_TOP_BAR_NEW_TASK,
  TID_WEB_TOP_BAR_TOGGLE_SIDEBAR,
  type IPlatformService,
  type UpdateStatePayload,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createWindowsCaptionControlsStyle,
  WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR,
} from "@/windowCaptionControls.js";
import { DesktopTopBarActions } from "@/app-shell/DesktopTopBarActions.js";
import {
  resolveDesktopTopOverlayHeightClassName,
  resolveDesktopTopOverlayWebInnerClassName,
  resolveMacFullscreenTopOverlayInsetClassName,
  shouldHideDesktopTopOverlay,
} from "@/app-shell/workspaceShellResponsiveLayout.js";

interface DesktopTopOverlayProps {
  workspaceAbsPath: string;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  isDesktop?: boolean;
  macWindowControlsLeftPaddingPx?: number;
  windowsWindowControlsRightPaddingPx?: number;
  isSidebarVisible: boolean;
  updateReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
  toggleSidebarShortcutLabel: string;
  newTaskShortcutLabel: string;
  showNewTaskButton?: boolean;
  showWindowDragHandle?: boolean;
  appLogoUrl: string;
  platform: IPlatformService;
  onToggleSidebar: () => void;
  onCreateTask: () => void;
  newTaskDisabledReason?: string;
}

export function DesktopTopOverlay({
  workspaceAbsPath: _workspaceAbsPath,
  isMacDesktop,
  isMacFullscreen,
  isWindowsDesktop,
  isDesktop,
  macWindowControlsLeftPaddingPx,
  windowsWindowControlsRightPaddingPx,
  isSidebarVisible,
  updateReadyVersion,
  updateState,
  toggleSidebarShortcutLabel,
  newTaskShortcutLabel,
  showNewTaskButton,
  showWindowDragHandle = false,
  appLogoUrl,
  platform,
  onToggleSidebar,
  onCreateTask,
  newTaskDisabledReason,
}: DesktopTopOverlayProps) {
  const { intl } = useZCodeIntl();
  const isMacDesktopFlag = Boolean(isMacDesktop);
  const isWindowsDesktopFlag = Boolean(isWindowsDesktop);
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktopFlag && !isWindowsDesktopFlag);
  const usesCustomCaptionArea = isWindowsDesktopFlag || isLinuxDesktop;
  const toggleSidebarTitle = intl.formatMessage({
    id: "workspaceSidebar.toggleSidebar",
  });
  const newTaskTitle = intl.formatMessage({ id: "sidebar.newTask" });
  const macTopOverlayPaddingStyle =
    isMacDesktopFlag && !isMacFullscreen && Number.isFinite(macWindowControlsLeftPaddingPx)
      ? { paddingLeft: `${Math.round(macWindowControlsLeftPaddingPx ?? 96)}px` }
      : undefined;
  const windowsTopOverlayPaddingStyle = isWindowsDesktopFlag
    ? {
        ...createWindowsCaptionControlsStyle(windowsWindowControlsRightPaddingPx),
        paddingRight: WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR,
      }
    : undefined;
  const topOverlayWidthStyle = isSidebarVisible
    ? { width: "var(--workspace-sidebar-panel-width)" }
    : undefined;

  return (
    <div
      style={topOverlayWidthStyle}
      className={cn(
        "@container/topoverlayer pointer-events-none absolute flex left-0 top-0 z-20 w-fit",
        resolveDesktopTopOverlayHeightClassName({ isDesktop: Boolean(isDesktop) }),
        // Windows/Linux 主面板新增 4px 留白及 1px 边框，左侧工具组需同步偏移才能对齐 Header 中心线。
        usesCustomCaptionArea && "top-1 mt-px",
        // 网页入口不再换家：收起也不藏浮层，顶栏只留空槽。
        shouldHideDesktopTopOverlay({
          isDesktop: Boolean(isDesktop),
          isSidebarVisible,
        }) && "hidden",
      )}
      data-testid={!isDesktop ? TID_WEB_TOP_BAR : undefined}
    >
      <div
        style={{
          ...macTopOverlayPaddingStyle,
          ...windowsTopOverlayPaddingStyle,
        }}
        className={cn(
          "flex items-center",
          isMacDesktopFlag && "h-14",
          usesCustomCaptionArea && "h-12",
          // Windows/Linux 工具组计入 4px 外沿留白和 1px 边框，较 8px 左边距右移 5px。
          usesCustomCaptionArea && "pl-3 ml-px",
          // 网页浮层与收起态 Header 共用 48px 行高 + 12px 左边距，开关侧栏时按钮不跳。
          // 12px 同时对齐 Windows/Linux 桌面工具组；高度不再用桌面标题栏的 56px。
          !usesCustomCaptionArea &&
            !isMacDesktopFlag &&
            resolveDesktopTopOverlayWebInnerClassName(),
          isMacDesktopFlag &&
            (isMacFullscreen ? resolveMacFullscreenTopOverlayInsetClassName() : "pt-1"),
        )}
      >
        <div
          data-workspace-caption-actions=""
          className={cn(
            // 顶部浮层按钮虽然单个按钮打了 no-drag，但外层容器本身仍悬在窗口标题区上方。
            // Electron 在这类覆盖层上会优先按父级命中拖拽区域，导致点击被窗口拖动吞掉。
            // 这里把整块交互容器一起标成 no-drag，确保展开/收起和新建 task 都能稳定点击。
            "pointer-events-auto flex items-center gap-1 shrink-0 [app-region:no-drag]",
          )}
        >
          <DesktopTopBarActions
            appLogoUrl={appLogoUrl}
            usesLogoToggle={usesCustomCaptionArea}
            isSidebarVisible={isSidebarVisible}
            toggleSidebarTitle={toggleSidebarTitle}
            toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
            toggleButtonTestId={
              isDesktop ? "desktop-top-nav-toggle-sidebar" : TID_WEB_TOP_BAR_TOGGLE_SIDEBAR
            }
            newTaskTitle={newTaskTitle}
            newTaskShortcutLabel={newTaskShortcutLabel}
            newTaskDisabledReason={newTaskDisabledReason}
            newTaskButtonTestId={isDesktop ? undefined : TID_WEB_TOP_BAR_NEW_TASK}
            showNewTaskButton={showNewTaskButton}
            platform={platform}
            updateReadyVersion={updateReadyVersion}
            updateState={updateState}
            isMacDesktop={isMacDesktopFlag}
            isWindowsDesktop={isWindowsDesktopFlag}
            onToggleSidebar={onToggleSidebar}
            onCreateTask={onCreateTask}
          />
          {isDesktop && showWindowDragHandle ? (
            // 侧栏收起后只保留按钮旁的小块拖动空白，不能把整组按钮或文件 Tab 变成拖动区。
            <div
              data-workspace-window-drag-handle=""
              aria-hidden="true"
              className="h-7 w-5 shrink-0 pointer-events-auto [app-region:drag]"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
