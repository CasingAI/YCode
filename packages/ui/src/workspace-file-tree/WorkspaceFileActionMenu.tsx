import { createContext, useContext, type ReactElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceFileAction } from "@/workspace-file-tree/fileActionRules.js";
import type {
  WorkspaceFileActionController,
  WorkspaceFileActionEntry,
} from "@/workspace-file-tree/fileActionTypes.js";

export const WorkspaceFileActionContext = createContext<WorkspaceFileActionController | null>(null);
export function useWorkspaceFileActionController() {
  return useContext(WorkspaceFileActionContext);
}

export function WorkspaceFileActionMenuItems({
  entry,
  group,
}: {
  entry: WorkspaceFileActionEntry;
  group: "create" | "edit";
}) {
  const controller = useWorkspaceFileActionController();
  const { intl } = useZCodeIntl();
  if (!controller) return null;
  const item = (action: WorkspaceFileAction) => (
    <ContextMenuItem
      key={action}
      disabled={!controller.canRun(action, entry)}
      variant={action === "delete" ? "destructive" : "default"}
      onSelect={() => controller.run(action, entry)}
    >
      {intl.formatMessage({ id: `workspaceFileTree.actions.${action}` })}
    </ContextMenuItem>
  );
  if (group === "create") {
    return entry.type === "directory" ? (
      <>
        {item("create-file")}
        {item("create-directory")}
        <ContextMenuSeparator />
      </>
    ) : null;
  }
  if (entry.root) return item("paste");
  return (
    <>
      <ContextMenuSeparator />
      {item("cut")}
      {item("copy")}
      {entry.type === "directory" ? item("paste") : null}
      <ContextMenuSeparator />
      {item("rename")}
      {item("delete")}
    </>
  );
}

export function WorkspaceFileRootMenu({
  entry,
  children,
}: {
  entry: WorkspaceFileActionEntry;
  children: ReactElement;
}) {
  const controller = useWorkspaceFileActionController();
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          // 行有自己的菜单；空白区域才使用根目录菜单，避免冒泡同时打开两个菜单。
          if ((event.target as Element).closest("[data-workspace-file-row]"))
            event.preventDefault();
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          if (controller?.dialogOpen) event.preventDefault();
        }}
      >
        <WorkspaceFileActionMenuItems entry={entry} group="create" />
        <WorkspaceFileActionMenuItems entry={entry} group="edit" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
