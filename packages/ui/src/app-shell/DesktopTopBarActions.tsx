import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { MessageCirclePlus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { DesktopTopOverlayActionButton } from "@/DesktopTopOverlayActionButton.js";
import { UpdateStatusButton } from "@/UpdateStatusButton.js";

/**
 * 顶部全局入口组：侧栏切换、新建任务、更新状态。
 *
 * 桌面浮层（DesktopTopOverlay）与网页版各视图顶部区域（WorkspaceHeader 左侧、
 * AutomationsMainBreadcrumbFrame 面包屑带）共用这一份，
 * 保证两处入口的顺序与显隐条件一致，不出现"同一个入口、两套行为"的漂移
 * （见 docs/specs/mobile-remote-control.md 产品规则）。
 */
export function DesktopTopBarActions({
  appLogoUrl,
  usesLogoToggle,
  isSidebarVisible,
  toggleSidebarTitle,
  toggleSidebarShortcutLabel,
  toggleButtonTestId,
  newTaskTitle,
  newTaskShortcutLabel,
  newTaskDisabledReason,
  newTaskButtonTestId,
  showNewTaskButton,
  platform,
  updateReadyVersion,
  updateState,
  isMacDesktop,
  isWindowsDesktop,
  onToggleSidebar,
  onCreateTask,
}: {
  /** 仅 `usesLogoToggle` 时使用（logo 变体）。 */
  appLogoUrl?: string;
  /** Windows/Linux 桌面（自定义标题栏）：切换按钮平时显示 logo，hover 才露出切换图标。 */
  usesLogoToggle: boolean;
  isSidebarVisible: boolean;
  toggleSidebarTitle: string;
  toggleSidebarShortcutLabel: string;
  toggleButtonTestId: string;
  newTaskTitle: string;
  newTaskShortcutLabel: string;
  newTaskDisabledReason?: string;
  newTaskButtonTestId?: string;
  showNewTaskButton?: boolean;
  platform: IPlatformService;
  updateReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
  onToggleSidebar: () => void;
  onCreateTask: () => void;
}) {
  const SidebarToggleIcon = isSidebarVisible ? PanelLeftClose : PanelLeftOpen;
  const isNewTaskButtonVisible = showNewTaskButton ?? !isSidebarVisible;

  return (
    <>
      {usesLogoToggle ? (
        <DesktopTopOverlayActionButton
          title={toggleSidebarTitle}
          shortcut={toggleSidebarShortcutLabel}
          ariaLabel={toggleSidebarTitle}
          buttonClassName="group relative overflow-hidden rounded-lg"
          testId={toggleButtonTestId}
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
      ) : (
        <DesktopTopOverlayActionButton
          title={toggleSidebarTitle}
          shortcut={toggleSidebarShortcutLabel}
          ariaLabel={toggleSidebarTitle}
          testId={toggleButtonTestId}
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
          testId={newTaskButtonTestId}
          onClick={onCreateTask}
        >
          <MessageCirclePlus className="size-4" />
        </DesktopTopOverlayActionButton>
      </div>

      <UpdateStatusButton
        platform={platform}
        version={updateReadyVersion}
        updateState={updateState}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      />
    </>
  );
}
