import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import {
  TID_WEB_TOP_BAR,
  TID_WEB_TOP_BAR_NEW_TASK,
  TID_WEB_TOP_BAR_TOGGLE_SIDEBAR,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DesktopTopBarActions } from "./DesktopTopBarActions.js";

/**
 * 网页版（浏览器 / 手机远控，`isDesktop=false`）的顶部标题栏。
 *
 * 网页版没有窗口标题栏可依托，顶部改为这条**始终存在**的 48px 带子承载全局入口：
 * 宽度 <1024px（`@container/shell` 判定）时是有背景、有下边框的实体标题栏，
 * ≥1024px 时同一条带子透明，只作为预留带（视觉与桌面浮层一致，内容不再被按钮压住）。
 * 宽度判定走 container query，不引入 resize 监听；桌面 Electron 不渲染本组件。
 * 详见 docs/specs/mobile-remote-control.md 产品规则。
 */
export function WorkspaceWebTopBar({
  isSidebarVisible,
  showNewTaskButton,
  newTaskDisabledReason,
  toggleSidebarShortcutLabel,
  newTaskShortcutLabel,
  platform,
  updateReadyVersion,
  updateState,
  onToggleSidebar,
  onCreateTask,
}: {
  isSidebarVisible: boolean;
  showNewTaskButton: boolean;
  newTaskDisabledReason?: string;
  toggleSidebarShortcutLabel: string;
  newTaskShortcutLabel: string;
  platform: IPlatformService;
  updateReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
  onToggleSidebar: () => void;
  onCreateTask: () => void;
}) {
  const { intl } = useZCodeIntl();
  const toggleSidebarTitle = intl.formatMessage({ id: "workspaceSidebar.toggleSidebar" });
  const newTaskTitle = intl.formatMessage({ id: "sidebar.newTask" });

  return (
    <div
      data-testid={TID_WEB_TOP_BAR}
      className={cn(
        // UpdateStatusButton 的响应式展开走 @container/topoverlayer 查询，这里挂同名容器保持行为一致。
        "@container/topoverlayer flex h-12 shrink-0 items-center px-3",
        "@max-[1023px]/shell:border-b @max-[1023px]/shell:border-border @max-[1023px]/shell:bg-background",
      )}
    >
      <div className="flex items-center gap-1">
        <DesktopTopBarActions
          usesLogoToggle={false}
          isSidebarVisible={isSidebarVisible}
          toggleSidebarTitle={toggleSidebarTitle}
          toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
          toggleButtonTestId={TID_WEB_TOP_BAR_TOGGLE_SIDEBAR}
          newTaskTitle={newTaskTitle}
          newTaskShortcutLabel={newTaskShortcutLabel}
          newTaskDisabledReason={newTaskDisabledReason}
          newTaskButtonTestId={TID_WEB_TOP_BAR_NEW_TASK}
          showNewTaskButton={showNewTaskButton}
          platform={platform}
          updateReadyVersion={updateReadyVersion}
          updateState={updateState}
          isMacDesktop={false}
          isWindowsDesktop={false}
          onToggleSidebar={onToggleSidebar}
          onCreateTask={onCreateTask}
        />
      </div>
    </div>
  );
}
