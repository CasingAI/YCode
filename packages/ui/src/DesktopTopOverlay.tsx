import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { MessageCirclePlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { UpdateStatusButton } from "@/UpdateStatusButton.js";
import { DesktopTopOverlayActionButton } from "@/DesktopTopOverlayActionButton.js";
import {
  createWindowsCaptionControlsStyle,
  WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR,
} from "@/windowCaptionControls.js";

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
  const SidebarToggleIcon = isSidebarVisible ? PanelLeftClose : PanelLeftOpen;
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesCustomCaptionArea = isWindowsDesktop || isLinuxDesktop;
  const toggleSidebarTitle = intl.formatMessage({
    id: "workspaceSidebar.toggleSidebar",
  });
  const newTaskTitle = intl.formatMessage({ id: "sidebar.newTask" });
  const isNewTaskButtonVisible = showNewTaskButton ?? !isSidebarVisible;
  const macTopOverlayPaddingStyle =
    isMacDesktop && !isMacFullscreen && Number.isFinite(macWindowControlsLeftPaddingPx)
      ? { paddingLeft: `${Math.round(macWindowControlsLeftPaddingPx ?? 96)}px` }
      : undefined;
  const windowsTopOverlayPaddingStyle = isWindowsDesktop
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
          isMacDesktop && "h-14",
          usesCustomCaptionArea && "h-12",
          // Windows/Linux 工具组计入 4px 外沿留白和 1px 边框，较 8px 左边距右移 5px。
          usesCustomCaptionArea && "pl-3 ml-px",
          isMacDesktop &&
            (isMacFullscreen ? (!isSidebarVisible ? "pl-5 pt-1" : "pl-3 pt-1") : "pt-1"),
          // 浏览器 / 远端浏览器不在窗口标题栏内，没有红绿灯或窗口控件的安全区，之前这里没有任何
          // 内边距，侧栏切换按钮会紧贴窗口左上角。对齐 Windows/Linux 的 12px 左边距，并按浮层
          // 高度居中，让按钮与桌面端处在同一条视觉中心线上。
          !usesCustomCaptionArea && !isMacDesktop && "h-14 pl-3",
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
          {usesCustomCaptionArea && (
            <DesktopTopOverlayActionButton
              title={toggleSidebarTitle}
              shortcut={toggleSidebarShortcutLabel}
              ariaLabel={toggleSidebarTitle}
              buttonClassName="group relative overflow-hidden rounded-lg"
              testId="desktop-top-nav-toggle-sidebar"
              onClick={onToggleSidebar}
            >
              <img
                src={appLogoUrl}
                alt="YCode"
                className="size-5 transition-opacity duration-150 group-hover:opacity-0"
                draggable={false}
              />
              <SidebarToggleIcon className="absolute inset-0 m-auto size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            </DesktopTopOverlayActionButton>
          )}

          {/* 除「自定义标题栏」环境（Windows/Linux 桌面）外都必须渲染切换入口：侧栏自身不带折叠
              控件，这个按钮是所有环境里唯一能重新展开侧栏的地方，而自动收起策略会在窗口 resize
              后收起它。原先这里只判 isMacDesktop，浏览器 / 远端浏览器 isDesktop 为假，两个分支
              都不成立，侧栏收起后就再也没有入口。 */}
          {!usesCustomCaptionArea && (
            <DesktopTopOverlayActionButton
              title={toggleSidebarTitle}
              shortcut={toggleSidebarShortcutLabel}
              ariaLabel={toggleSidebarTitle}
              testId="desktop-top-nav-toggle-sidebar"
              onClick={onToggleSidebar}
            >
              <SidebarToggleIcon className="size-4" />
            </DesktopTopOverlayActionButton>
          )}

          <div
            aria-hidden={!isNewTaskButtonVisible}
            className={cn(
              "inline-flex overflow-hidden transition-[opacity,width] duration-300 ease-out",
              isNewTaskButtonVisible ? "w-7 opacity-100" : "pointer-events-none w-0 opacity-0",
            )}
          >
            <DesktopTopOverlayActionButton
              title={newTaskDisabledReason ?? newTaskTitle}
              shortcut={newTaskShortcutLabel}
              ariaLabel={newTaskTitle}
              disabled={Boolean(newTaskDisabledReason)}
              onClick={onCreateTask}
            >
              <MessageCirclePlus className="size-4" />
            </DesktopTopOverlayActionButton>
          </div>

          {/* <div className="flex items-center [app-region:no-drag]"> */}
          {/* 侧栏收起后，更新按钮之前会跟着“展开态的容器宽度阈值”一起被隐藏。
                  但收起态本身已经改成把操作集中到顶部浮层里，如果这里还继续依赖侧栏宽度判断，
                  用户就会在最需要全局入口的时候反而看不到更新按钮。
                  所以展开态继续走容器查询，收起态则强制显示。 */}
          <UpdateStatusButton
            platform={platform}
            version={updateReadyVersion}
            updateState={updateState}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
          />
          {/* </div> */}
        </div>
      </div>
    </div>
  );
}
