/**
 * 命令中心全局入口 → 打开时的初始范围。
 *
 * 三个入口共用同一个命令中心浮层，区别只在打开时落在哪个范围：
 * - Cmd/Ctrl+K → all（聚合搜索：命令 + 会话 + 文件）
 * - Cmd/Ctrl+P → files（快速打开：只搜工作区文件）
 * - Cmd/Ctrl+Shift+P → commands（命令面板：只列应用命令）
 *
 * 范围事实仍由命令中心内部持有（manualScope），本模块只负责入口到范围的映射。
 */
import type { CommandCenterSearchScope } from "@/command-center/commandCenterSearchHistory.js";

/** 命令中心的全局入口（与快捷键命令表里的 ID 对齐）。 */
export type CommandCenterLaunchId = "openCommandCenter" | "openQuickOpen" | "openCommandPalette";

/** 入口 → 初始范围。 */
export const COMMAND_CENTER_LAUNCH_SCOPE: Readonly<
  Record<CommandCenterLaunchId, CommandCenterSearchScope>
> = {
  openCommandCenter: "all",
  openQuickOpen: "files",
  openCommandPalette: "commands",
};

/** 取入口对应的初始范围。 */
export function resolveCommandCenterLaunchScope(
  launchId: CommandCenterLaunchId,
): CommandCenterSearchScope {
  return COMMAND_CENTER_LAUNCH_SCOPE[launchId];
}
