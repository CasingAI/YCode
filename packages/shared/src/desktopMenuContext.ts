import { z } from "zod";

/**
 * 桌面应用菜单的上下文投影。
 *
 * 渲染进程是菜单上下文的事实所有者：外壳主视图、当前编辑器能力、未保存数量都在
 * 渲染进程里成立。主进程只保存这份投影，用来决定应用菜单里哪些条目出现、哪些置灰。
 *
 * 投影只含菜单需要的布尔量与计数，不含文件正文，也不含可写缓冲。
 */

/** 外壳主视图：任务、文件、设置。与 `WorkspaceShellPrimaryView` 取值一致。 */
export const DESKTOP_MENU_PRIMARY_VIEWS = ["tasks", "files", "settings"] as const;

export type DesktopMenuPrimaryView = (typeof DESKTOP_MENU_PRIMARY_VIEWS)[number];

/** 文件界面下的编辑器能力。 */
const desktopMenuEditorStateSchema = z.object({
  /** 当前聚焦编辑器组是否有可关闭的标签。 */
  hasActiveEditor: z.boolean(),
  /** 当前标签是否是可保存的文本文件（只读预览不可保存；未命名文件可保存，走另存为）。 */
  canSave: z.boolean(),
  /** 全部打开的标签里未保存的文件数量。 */
  dirtyFileCount: z.number().int().nonnegative(),
});

export type DesktopMenuEditorState = z.infer<typeof desktopMenuEditorStateSchema>;

/**
 * 菜单上下文。`editor` 只在 `view === "files"` 时非 null；
 * 其它视图没有编辑器能力可言，传 null 而不是空对象。
 */
export const desktopMenuContextSchema = z.object({
  view: z.enum(DESKTOP_MENU_PRIMARY_VIEWS),
  editor: desktopMenuEditorStateSchema.nullable(),
});

export type DesktopMenuContext = z.infer<typeof desktopMenuContextSchema>;

/** 判定上下文是否描述文件编辑器界面。 */
export function isDesktopMenuFilesView(context: DesktopMenuContext | null | undefined): boolean {
  return context?.view === "files";
}
