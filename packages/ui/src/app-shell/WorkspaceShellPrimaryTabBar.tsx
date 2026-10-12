import { ListTodo, Settings } from "lucide-react";
import { TID_WORKSPACE_SHELL_PRIMARY_TAB, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceShellPrimaryView } from "@/app-shell/types.js";

export function WorkspaceShellPrimaryTabBar({
  activeView,
  onShowTasks,
  onShowSettings,
  tasksEnabled = true,
}: {
  activeView: WorkspaceShellPrimaryView;
  onShowTasks: () => void;
  onShowSettings: () => void;
  tasksEnabled?: boolean;
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
      <div className="grid grid-cols-2 gap-1">
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
      className={cn(
        "flex h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-ui-sm transition-colors",
        active
          ? "bg-card-selected text-foreground"
          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
