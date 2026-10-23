import { UiCommandIds, type UiCommandId } from "@zcode/shared";
import { resolveEditCommandTarget } from "@/shortcuts/editCommandTarget.js";

/** 原生菜单与工作台菜单共用编辑目标路由，点击菜单失焦后仍作用于原编辑区。 */
export function executeEditMenuCommand(
  command: UiCommandId,
  view: "tasks" | "files" | "settings",
): boolean {
  const target = resolveEditCommandTarget(view);
  if (!target) return false;
  switch (command) {
    case UiCommandIds.Undo:
      target.undo();
      return true;
    case UiCommandIds.Redo:
      target.redo();
      return true;
    case UiCommandIds.FindInEditor:
      return target.find?.() ?? false;
    case UiCommandIds.FindReplaceInEditor:
      return target.find?.({ replace: true }) ?? false;
    default:
      return false;
  }
}
