/**
 * Monaco 编辑器右键菜单的本地化映射。
 *
 * Monaco 的 ESM 产物不内置语言包，右键菜单文案硬编码为英文；
 * 这里按「命令 id」「子菜单 id」登记应用侧语言键，运行时改写菜单标题。
 *
 * 命令 id 取自 monaco-editor 的 action id（公开语义标识），比英文文案稳定；
 * 升级 monaco-editor 时需要复核这份表：新增的菜单项不会自动本地化。
 */

/** 右键菜单命令 id → 应用语言键 */
export const FILES_MONACO_CONTEXT_MENU_COMMAND_KEYS: Readonly<Record<string, string>> = {
  "editor.action.revealDefinition": "filesWorkbench.editorContextMenu.goToDefinition",
  "editor.action.revealDefinitionAside": "filesWorkbench.editorContextMenu.openDefinitionToSide",
  "editor.action.revealDeclaration": "filesWorkbench.editorContextMenu.goToDeclaration",
  "editor.action.goToTypeDefinition": "filesWorkbench.editorContextMenu.goToTypeDefinition",
  "editor.action.goToImplementation": "filesWorkbench.editorContextMenu.goToImplementations",
  "editor.action.goToReferences": "filesWorkbench.editorContextMenu.goToReferences",
  "editor.action.quickOutline": "filesWorkbench.editorContextMenu.goToSymbol",
  "editor.action.quickCommand": "filesWorkbench.editorContextMenu.commandPalette",
  "editor.action.refactor": "filesWorkbench.editorContextMenu.refactor",
  "editor.action.sourceAction": "filesWorkbench.editorContextMenu.sourceAction",
  "editor.action.rename": "filesWorkbench.editorContextMenu.renameSymbol",
  "editor.action.changeAll": "filesWorkbench.editorContextMenu.changeAllOccurrences",
  "editor.action.selectHighlights": "filesWorkbench.editorContextMenu.selectAllOccurrences",
  "editor.action.formatDocument": "filesWorkbench.editorContextMenu.formatDocument",
  "editor.action.formatSelection": "filesWorkbench.editorContextMenu.formatSelection",
  "editor.action.clipboardCutAction": "filesWorkbench.editorContextMenu.cut",
  "editor.action.clipboardCopyAction": "filesWorkbench.editorContextMenu.copy",
  "editor.action.clipboardPasteAction": "filesWorkbench.editorContextMenu.paste",
  "editor.action.clipboardCopyWithSyntaxHighlightingAction":
    "filesWorkbench.editorContextMenu.copyWithSyntaxHighlighting",
  "editor.action.peekDefinition": "filesWorkbench.editorContextMenu.peekDefinition",
  "editor.action.peekDeclaration": "filesWorkbench.editorContextMenu.peekDeclaration",
  "editor.action.peekTypeDefinition": "filesWorkbench.editorContextMenu.peekTypeDefinition",
  "editor.action.peekImplementation": "filesWorkbench.editorContextMenu.peekImplementations",
  "editor.action.referenceSearch.trigger": "filesWorkbench.editorContextMenu.peekReferences",
};

/** 右键菜单子菜单 id（MenuId）→ 应用语言键 */
export const FILES_MONACO_CONTEXT_MENU_SUBMENU_KEYS: Readonly<Record<string, string>> = {
  EditorContextPeek: "filesWorkbench.editorContextMenu.peek",
  EditorContextCopy: "filesWorkbench.editorContextMenu.copyAs",
  EditorContextShare: "filesWorkbench.editorContextMenu.share",
};

/** 取命令 id 对应的语言键；未登记的命令返回 undefined，保留 Monaco 原文 */
export function resolveFilesMonacoContextMenuCommandKey(
  commandId: string | undefined,
): string | undefined {
  return commandId ? FILES_MONACO_CONTEXT_MENU_COMMAND_KEYS[commandId] : undefined;
}

/** 取子菜单 id 对应的语言键；未登记的子菜单返回 undefined，保留 Monaco 原文 */
export function resolveFilesMonacoContextMenuSubmenuKey(
  submenuId: string | undefined,
): string | undefined {
  return submenuId ? FILES_MONACO_CONTEXT_MENU_SUBMENU_KEYS[submenuId] : undefined;
}

/** 这份映射里用到的全部语言键 */
export function listFilesMonacoContextMenuLocaleKeys(): string[] {
  return [
    ...Object.values(FILES_MONACO_CONTEXT_MENU_COMMAND_KEYS),
    ...Object.values(FILES_MONACO_CONTEXT_MENU_SUBMENU_KEYS),
  ];
}
