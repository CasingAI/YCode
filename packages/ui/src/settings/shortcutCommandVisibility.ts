import type { ShortcutCommandId } from "@zcode/shared";

/**
 * 设置页快捷键命令行的可见性。
 *
 * 命令不在列表里展示有三种原因：
 * - 内部保留键（仍参与冲突检测，但不出现在用户可见列表）；
 * - 只在桌面端实现的命令：Web 端没有宿主应用菜单，展示了也是「显示键位但按下没反应」；
 * - 其余命令按搜索词与按键过滤结果展示。
 */

/** 内部保留键：参与冲突检测，不在用户可见列表中展示。 */
const HIDDEN_COMMAND_IDS: readonly ShortcutCommandId[] = ["toggleInterfaceMode"];

/** 只在桌面端实现的命令（依赖宿主应用菜单）。 */
const DESKTOP_ONLY_COMMAND_IDS: readonly ShortcutCommandId[] = ["closeActiveContext"];

/**
 * 判断一条命令是否出现在设置页列表里。
 *
 * @param options.isDesktop 当前端是否为桌面端（宿主应用菜单存在）。
 */
export function isShortcutCommandListed(
  commandId: ShortcutCommandId,
  options: { isDesktop: boolean },
): boolean {
  if (HIDDEN_COMMAND_IDS.includes(commandId)) {
    return false;
  }
  if (!options.isDesktop && DESKTOP_ONLY_COMMAND_IDS.includes(commandId)) {
    return false;
  }
  return true;
}
