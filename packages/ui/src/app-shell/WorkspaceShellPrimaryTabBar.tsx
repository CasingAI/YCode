import type { ReactNode } from "react";
import { Files, ListTodo, Settings } from "lucide-react";
import { TID_WORKSPACE_SHELL_PRIMARY_TAB, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceShellPrimaryView } from "@/app-shell/types.js";

/**
 * 五格文案：导航条容器够宽时显示，窄于 360px 时隐藏（读名走按钮 aria-label）。
 * 「更多」触发器共用；断点与 `@container/shell-primary-tab` 配套。
 */
export const workspaceShellPrimaryTabLabelClassName =
  "truncate @max-[360px]/shell-primary-tab:hidden";

export function workspaceShellPrimaryTabTriggerClassName(params: {
  selected: boolean;
  disabled?: boolean;
  remoteEnabled?: boolean;
}): string {
  return cn(
    "flex h-9 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-ui-sm transition-colors",
    // 只留图标时收掉与文字的间距，五格更匀。
    "@max-[360px]/shell-primary-tab:gap-0",
    params.selected
      ? "bg-card-selected text-foreground"
      : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
    params.disabled && "pointer-events-none opacity-40",
    // 远控开启态必须压过未选中的 subtle 字色：这是侧栏里唯一的远控还开着信号。
    params.remoteEnabled && "text-orange-500 hover:text-orange-500",
  );
}

export function WorkspaceShellPrimaryTabBar({
  activeView,
  onShowTasks,
  onShowFiles,
  onShowSettings,
  tasksEnabled = true,
  moreMenu,
}: {
  activeView: WorkspaceShellPrimaryView;
  onShowTasks: () => void;
  onShowFiles: () => void;
  onShowSettings: () => void;
  tasksEnabled?: boolean;
  moreMenu: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const tasksLabel = intl.formatMessage({ id: "workspaceShell.primaryTab.tasks" });
  const filesLabel = intl.formatMessage({ id: "workspaceShell.primaryTab.files" });
  const settingsLabel = intl.formatMessage({ id: "workspaceShell.primaryTab.settings" });
  const tasksUnavailableLabel = intl.formatMessage({
    id: "workspaceShell.primaryTab.tasksUnavailable",
  });

  return (
    <nav
      aria-label={intl.formatMessage({ id: "workspaceShell.primaryTab.label" })}
      className="@container/shell-primary-tab shrink-0 border-t border-border px-2 py-2"
      data-testid={TID_WORKSPACE_SHELL_PRIMARY_TAB}
    >
      <div className="grid grid-cols-4 gap-1">
        <WorkspaceShellPrimaryTabButton
          testIdSuffix="tasks"
          label={tasksEnabled ? tasksLabel : tasksUnavailableLabel}
          icon={ListTodo}
          active={activeView === "tasks"}
          disabled={!tasksEnabled}
          onClick={onShowTasks}
        />
        <WorkspaceShellPrimaryTabButton
          testIdSuffix="files"
          label={filesLabel}
          icon={Files}
          active={activeView === "files"}
          onClick={onShowFiles}
        />

        <WorkspaceShellPrimaryTabButton
          testIdSuffix="settings"
          label={settingsLabel}
          icon={Settings}
          active={activeView === "settings"}
          onClick={onShowSettings}
        />
        {moreMenu}
      </div>
    </nav>
  );
}

function WorkspaceShellPrimaryTabButton({
  testIdSuffix,
  label,
  icon: Icon,
  active,
  disabled = false,
  unread = false,
  onClick,
}: {
  testIdSuffix: WorkspaceShellPrimaryView;
  label: string;
  icon: typeof ListTodo;
  active: boolean;
  disabled?: boolean;
  unread?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId(TID_WORKSPACE_SHELL_PRIMARY_TAB, testIdSuffix)}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (!disabled && !active) {
          onClick();
        }
      }}
      className={cn(
        "relative",
        workspaceShellPrimaryTabTriggerClassName({ selected: active, disabled }),
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className={workspaceShellPrimaryTabLabelClassName}>{label}</span>
      {unread ? (
        <span
          className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-brand @max-[360px]/shell-primary-tab:right-1 @max-[360px]/shell-primary-tab:top-1"
          aria-hidden
        />
      ) : null}
    </button>
  );
}
