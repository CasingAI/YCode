import type { ReactNode } from "react";
import { ListTodo, Settings } from "lucide-react";
import { TID_WORKSPACE_SHELL_PRIMARY_TAB, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceShellPrimaryView } from "@/app-shell/types.js";

export function workspaceShellPrimaryTabTriggerClassName(params: {
  selected: boolean;
  disabled?: boolean;
  remoteEnabled?: boolean;
}): string {
  return cn(
    "flex h-9 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-ui-sm transition-colors",
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
  onShowSettings,
  tasksEnabled = true,
  moreMenu,
}: {
  activeView: WorkspaceShellPrimaryView;
  onShowTasks: () => void;
  onShowSettings: () => void;
  tasksEnabled?: boolean;
  moreMenu: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const tasksLabel = intl.formatMessage({ id: "workspaceShell.primaryTab.tasks" });
  const settingsLabel = intl.formatMessage({ id: "workspaceShell.primaryTab.settings" });
  const tasksUnavailableLabel = intl.formatMessage({
    id: "workspaceShell.primaryTab.tasksUnavailable",
  });

  return (
    <nav
      aria-label={intl.formatMessage({ id: "workspaceShell.primaryTab.label" })}
      className="shrink-0 border-t border-border px-2 py-2"
      data-testid={TID_WORKSPACE_SHELL_PRIMARY_TAB}
    >
      <div className="grid grid-cols-3 gap-1">
        <WorkspaceShellPrimaryTabButton
          testIdSuffix="tasks"
          label={tasksEnabled ? tasksLabel : tasksUnavailableLabel}
          icon={ListTodo}
          active={activeView === "tasks"}
          disabled={!tasksEnabled}
          onClick={onShowTasks}
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
  onClick,
}: {
  testIdSuffix: WorkspaceShellPrimaryView;
  label: string;
  icon: typeof ListTodo;
  active: boolean;
  disabled?: boolean;
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
      className={workspaceShellPrimaryTabTriggerClassName({ selected: active, disabled })}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
