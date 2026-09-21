import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createWindowsCaptionControlsStyle,
  WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR,
} from "@/windowCaptionControls.js";
import { DesktopTopBarActions } from "@/app-shell/DesktopTopBarActions.js";

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
  appLogoUrl,
  platform,
  onToggleSidebar,
  onCreateTask,
  newTaskDisabledReason,
}: DesktopTopOverlayProps) {
  const { intl } = useZCodeIntl();
  // 网页版（浏览器 / 手机远控）没有窗口标题栏可依托，三个全局入口改由 shell 顶部的
  // WorkspaceWebTopBar 带子承担（见 docs/specs/mobile-remote-control.md），
  // 这里不再渲染浮层，避免同一个入口出现两份。
  if (!isDesktop) {
    return null;
  }
  const isMacDesktopFlag = Boolean(isMacDesktop);
  const isWindowsDesktopFlag = Boolean(isWindowsDesktop);
  const isLinuxDesktop = !isMacDesktopFlag && !isWindowsDesktopFlag;
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
        "@container/topoverlayer pointer-events-none absolute h-14 flex left-0 top-0 z-20 w-fit",
        // Windows/Linux 主面板新增 4px 留白及 1px 边框，左侧工具组需同步偏移才能对齐 Header 中心线。
        usesCustomCaptionArea && "top-1 mt-px",
      )}
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
          isMacDesktopFlag &&
            (isMacFullscreen ? (!isSidebarVisible ? "pl-5 pt-1" : "pl-3 pt-1") : "pt-1"),
        )}
      >
        <div
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
            toggleButtonTestId="desktop-top-nav-toggle-sidebar"
            newTaskTitle={newTaskTitle}
            newTaskShortcutLabel={newTaskShortcutLabel}
            newTaskDisabledReason={newTaskDisabledReason}
            showNewTaskButton={showNewTaskButton}
            platform={platform}
            updateReadyVersion={updateReadyVersion}
            updateState={updateState}
            isMacDesktop={isMacDesktopFlag}
            isWindowsDesktop={isWindowsDesktopFlag}
            onToggleSidebar={onToggleSidebar}
            onCreateTask={onCreateTask}
          />
        </div>
      </div>
    </div>
  );
}
