import {
  resolveFilesMonacoContextMenuCommandKey,
  resolveFilesMonacoContextMenuSubmenuKey,
} from "@/files-workbench/filesMonacoContextMenuLabels.js";

/**
 * Monaco 菜单标题：普通字符串，或 localize2 产生的对象。
 */
export type FilesMonacoMenuTitle = string | { value?: string; original?: string };

export interface FilesMonacoMenuCommand {
  id?: string;
  title?: FilesMonacoMenuTitle;
}

export interface FilesMonacoMenuId {
  id: string;
}

export interface FilesMonacoMenuItem {
  command?: FilesMonacoMenuCommand;
  submenu?: FilesMonacoMenuId;
  title?: FilesMonacoMenuTitle;
}

/**
 * Monaco 菜单注册表的最小结构。
 *
 * 这里刻意不直接依赖 monaco 内部模块：菜单注册表按菜单 id 对象做键，
 * 换一份实例就改不到编辑器真正使用的那份注册表。
 */
export interface FilesMonacoMenuRegistry {
  getMenuItems(menuId: FilesMonacoMenuId): FilesMonacoMenuItem[];
}

/**
 * Monaco 菜单项在注册表里是长生命周期的：改写标题后，切语言要靠它还原英文原文。
 * 这里按「持有 title 的对象」缓存原文，命令项缓存 command，子菜单项缓存菜单项本身。
 */
const originalTitles = new WeakMap<object, FilesMonacoMenuTitle | undefined>();

interface TitleHolder {
  title?: FilesMonacoMenuTitle;
}

function setLocalizedTitle(
  holder: TitleHolder,
  localeKey: string | undefined,
  translate: (key: string) => string,
): void {
  if (!originalTitles.has(holder)) {
    originalTitles.set(holder, holder.title);
  }
  const original = originalTitles.get(holder);
  holder.title = localeKey ? translate(localeKey) : original;
}

/**
 * 收集编辑器右键菜单的全部菜单项，包含 Peek / Copy As / Share 等子菜单。
 * 子菜单 id 由菜单项自身给出，递归一层即可覆盖当前 Monaco 的菜单结构。
 */
function collectEditorContextMenuItems(
  registry: FilesMonacoMenuRegistry,
  editorContextMenuId: FilesMonacoMenuId,
): FilesMonacoMenuItem[] {
  const items: FilesMonacoMenuItem[] = [];
  const visitedMenuIds = new Set<string>();
  const visit = (menuId: FilesMonacoMenuId) => {
    if (visitedMenuIds.has(menuId.id)) {
      return;
    }
    visitedMenuIds.add(menuId.id);
    for (const item of registry.getMenuItems(menuId)) {
      items.push(item);
      if (item.submenu) {
        visit(item.submenu);
      }
    }
  };
  visit(editorContextMenuId);
  return items;
}

/**
 * 按当前语言改写 Monaco 编辑器右键菜单的文案。
 *
 * Monaco 的 ESM 产物不带语言包，菜单默认英文；这里直接改写注册表里的菜单标题，
 * 保留 Monaco 自身的命令、快捷键、显隐条件与分组，只是换掉展示文案。
 */
export function applyFilesMonacoContextMenuLocale(
  registry: FilesMonacoMenuRegistry,
  editorContextMenuId: FilesMonacoMenuId,
  translate: (key: string) => string,
): void {
  for (const item of collectEditorContextMenuItems(registry, editorContextMenuId)) {
    const commandKey = resolveFilesMonacoContextMenuCommandKey(item.command?.id);
    if (item.command && commandKey) {
      setLocalizedTitle(item.command, commandKey, translate);
      continue;
    }
    const submenuKey = resolveFilesMonacoContextMenuSubmenuKey(item.submenu?.id);
    if (item.submenu && submenuKey) {
      setLocalizedTitle(item, submenuKey, translate);
    }
  }
}
