import { MenuId, MenuRegistry } from "monaco-editor/platform/actions/common/actions.js";
import { applyFilesMonacoContextMenuLocale } from "@/files-workbench/filesMonacoContextMenuLocale.js";

/**
 * 把 Monaco 内部菜单注册表接到文件工作台的本地化逻辑上。
 *
 * 这一层是唯一接触 monaco 内部模块的地方：monaco 的 ESM 产物不带语言包，
 * 右键菜单文案硬编码英文，而公开 API 没有改写菜单标题的入口。
 *
 * 注意：必须与 `import("monaco-editor")` 解析到同一份模块实例，
 * 否则改到的是另一份注册表，菜单仍是英文。Vite 的依赖预构建会把两者合并到同一 chunk。
 */
export function applyFilesMonacoContextMenuLocaleForEditor(
  translate: (key: string) => string,
): void {
  applyFilesMonacoContextMenuLocale(MenuRegistry, MenuId.EditorContext, translate);
}
