import type { WindowCommand } from "@zcode/shared";
import type { TabStore } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * 权威端执行镜像端下发的窗口结构命令。
 *
 * 命令是窗口结构唯一的写路径：镜像端不自己改本地集合，只发命令，
 * 权威端执行完再通过快照回传，因此两端不会各持一份互相矛盾的状态。
 */
export async function executeWindowCommand(params: {
  command: WindowCommand;
  tabStore: TabStore;
  /** 打开工作区：复用窗口既有的打开流程（草稿预热、最近项目更新）。 */
  openWorkspace?: (
    workspacePath: string,
    options?: {
      workspaceIdentity?: string;
      skipCrossWindowActivation?: boolean;
    },
  ) => void | Promise<void>;
}): Promise<void> {
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
        await openWorkspace?.(command.workspacePath, {
          // 手机连的是权威端这个具体窗口：跳去别的窗口会让手机端看不到任何变化。
          skipCrossWindowActivation: true,
        });
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
      return;
    }
    case "ensure-workspace": {
      const identity = command.workspaceIdentity;
      state.ensureWorkspaceTab(
        command.workspacePath,
        identity ? { workspaceIdentity: identity } : {},
      );
      return;
    }
    case "close-workspace": {
      state.closeTab(command.entryId);
      return;
    }
    case "activate-workspace": {
      state.activateTab(command.entryId);
      return;
    }
    case "reorder-workspaces": {
      state.reorderWorkspaceTabs(command.fromIndex, command.toIndex);
      return;
    }
    case "set-workspace-expanded": {
      state.setWorkspaceExpanded(command.workspacePath, command.expanded);
      return;
    }
    case "activate-task": {
      useZCodeSessionStore
        .getState()
        .setActiveTaskId(
          command.workspacePath,
          command.taskId,
          command.workspaceIdentity,
        );
      return;
    }
  }
}
