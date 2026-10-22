import type { WindowCommand, WindowCommandOutcome } from "@zcode/shared";
import type { TabStore } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * 权威端执行镜像端下发的窗口结构命令。
 *
 * 命令是窗口结构唯一的写路径：镜像端不自己改本地集合，只发命令，
 * 权威端执行完再通过快照回传，因此两端不会各持一份互相矛盾的状态。
 *
 * 返回值是执行结果：`opened-in-other-window` 表示该工作区已经在另一个桌面窗口
 * 打开，权威端沿用既有跨窗口激活语义把它交给了那个窗口，本窗口不会出现它。
 * 镜像端据此提示"已在其它窗口打开"，避免用户以为命令没生效。
 */
export async function executeWindowCommand(params: {
  command: WindowCommand;
  tabStore: TabStore;
  /** 打开工作区：复用窗口既有的打开流程（草稿预热、最近项目更新）。 */
  openWorkspace?: (
    workspacePath: string,
  ) => Promise<{ openedInOtherWindow: boolean } | void> | { openedInOtherWindow: boolean } | void;
}): Promise<WindowCommandOutcome> {
  const { command, tabStore, openWorkspace } = params;
  const state = tabStore.getState();
  switch (command.type) {
    case "open-workspace": {
      const identity = command.workspaceIdentity;
      if (identity) {
        // 远程工作区不能走本地打开流程：本地流程不知道 remoteSessionId，
        // 只会建出一个连不上的空 tab。这里只确保存在并激活。
        const tabId = state.ensureWorkspaceTab(command.workspacePath, {
          workspaceIdentity: identity,
        });
        state.activateTab(tabId);
      } else {
        const opened = await openWorkspace?.(command.workspacePath);
        if (opened?.openedInOtherWindow) {
          return "opened-in-other-window";
        }
      }
      if (command.activateTaskId) {
        // 打开工作区会清掉该工作区的当前会话（workspace-only 意图），
        // 深链必须紧接着把目标会话激活回来。
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(
            command.workspacePath,
            command.activateTaskId,
            identity,
          );
      }
      return "applied";
    }
    case "ensure-workspace": {
      const identity = command.workspaceIdentity;
      state.ensureWorkspaceTab(
        command.workspacePath,
        identity ? { workspaceIdentity: identity } : {},
      );
      return "applied";
    }
    case "close-workspace": {
      state.closeTab(command.entryId);
      return "applied";
    }
    case "activate-workspace": {
      state.activateTab(command.entryId);
      return "applied";
    }
    case "reorder-workspaces": {
      state.reorderWorkspaceTabs(command.fromIndex, command.toIndex);
      return "applied";
    }
    case "set-workspace-expanded": {
      state.setWorkspaceExpanded(command.workspacePath, command.expanded);
      return "applied";
    }
    case "activate-task": {
      useZCodeSessionStore
        .getState()
        .setActiveTaskId(
          command.workspacePath,
          command.taskId,
          command.workspaceIdentity,
        );
      return "applied";
    }
  }
}
