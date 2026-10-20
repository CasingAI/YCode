import {
  getDefaultShortcutBindings,
  getMenuDisplayShortcutBindings,
  isValidShortcutBinding,
} from "@zcode/shared";

/** 菜单通道命令的快捷键共享 options 类型（shortcutBindings 为 setting.json 里的用户覆盖）。 */
export interface ApplicationMenuShortcutOptions {
  shortcutBindings?: Record<string, string[]>;
}

/**
 * 菜单展示用的键位文本：规范形式里单个小写字母键统一大写，
 * 与设置页的键位显示保持一致（设置页用大写字母展示）。
 */
function toDisplayAccelerator(binding: string | undefined): string | undefined {
  if (binding === undefined) {
    return undefined;
  }
  const parts = binding.split("+");
  const key = parts[parts.length - 1];
  if (key !== undefined && key.length === 1 && key >= "a" && key <= "z") {
    parts[parts.length - 1] = key.toUpperCase();
    return parts.join("+");
  }
  return binding;
}

export function resolveMenuAccelerator(
  options: ApplicationMenuShortcutOptions & { disableShortcutAccelerators?: boolean },
  commandId: string,
): string | undefined {
  if (options.disableShortcutAccelerators) {
    return undefined;
  }
  // 默认键位取自共享的命令表，菜单与设置页不会各写一份而漂移。
  const fallback = getDefaultShortcutBindings(commandId)[0];
  // `?.find(isValid) ?? fallback` 会把「显式空数组 = 未设置」和
  // 「全部非法 = 回退默认」压成同一条路径，抢绑后被抢命令的默认 accelerator 复活，
  // 同键双动作且与「被抢命令变未设置」的 UI 承诺矛盾。
  const overrideList = options?.shortcutBindings?.[commandId];
  if (overrideList !== undefined) {
    if (overrideList.length === 0) {
      return undefined;
    }
    return toDisplayAccelerator(
      overrideList.find((binding) => isValidShortcutBinding(binding)) ?? fallback,
    );
  }
  return toDisplayAccelerator(fallback);
}

/**
 * 只在菜单里展示的固定键位（撤销 / 重做 / 查找 / 查找替换）。
 *
 * 这些命令由系统菜单直接执行，渲染进程的快捷键分发接管不了，
 * 键位固定且不可改键；键位本身登记在共享的快捷键命令表里，菜单不再另写一份。
 */
export function resolveMenuDisplayAccelerator(
  options: { disableShortcutAccelerators?: boolean },
  commandId: string,
): string | undefined {
  if (options.disableShortcutAccelerators) {
    return undefined;
  }
  return toDisplayAccelerator(getMenuDisplayShortcutBindings(commandId)[0]);
}
