import { useEffect } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { resolveWorkspaceShellPrimaryView } from "@/store/tabStore.js";
import { executeEditMenuCommand } from "@/shortcuts/editMenuCommand.js";

/**
 * 桌面菜单「编辑」分组里的命令分发：撤销、重做、查找、查找替换。
 *
 * 这些命令不属于任何单一视图：作用对象由「操作发生前的编辑焦点」决定——
 * 焦点在代码编辑器时作用于编辑器，焦点在聊天输入框时作用于输入框。
 * 菜单点击会让网页失焦，所以目标由编辑目标注册表记录，不能看点击瞬间的 activeElement。
 *
 * 保存、新建文件、关闭编辑器等文件状态相关的命令由文件工作台自己消费（它是文件状态的所有者）。
 */
export function useDesktopMenuEditCommands(): void {
  const platform = usePlatform();
  const tabStore = useTabStoreApi();

  useEffect(() => {
    if (!platform.onExecuteUiCommand) {
      return;
    }
    return platform.onExecuteUiCommand((command) => {
      // 命令到达时读取唯一主视图 owner，避免菜单打开后切界面仍使用旧投影。
      const state = tabStore.getState();
      const view = resolveWorkspaceShellPrimaryView(
        state.tabs.find((candidate) => candidate.id === state.activeTabId),
      );
      executeEditMenuCommand(command, view);
    });
  }, [platform, tabStore]);
}
