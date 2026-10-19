/**
 * monaco-editor 内部模块的最小类型声明。
 *
 * 这些模块不在 monaco 的公开入口（`monaco-editor`）里，只用于本地化编辑器右键菜单。
 * monaco-editor 的 package exports 把 `./*` 映射到 `esm/vs/*`，
 * 所以 `monaco-editor/platform/actions/common/actions.js`
 * 就是 `esm/vs/platform/actions/common/actions.js`。
 *
 * 升级 monaco-editor 时必须复核这里的字段：菜单结构一旦变化，
 * 右键菜单本地化会静默失效（菜单项退回英文），不会报错。
 */
declare module "monaco-editor/platform/actions/common/actions.js" {
  export interface IMonacoLocalizedString {
    value: string;
    original?: string;
  }

  export type MonacoMenuTitle = string | IMonacoLocalizedString;

  export interface IMonacoMenuCommand {
    id: string;
    title?: MonacoMenuTitle;
  }

  export interface IMonacoMenuId {
    id: string;
  }

  export interface IMonacoMenuItem {
    command?: IMonacoMenuCommand;
    submenu?: IMonacoMenuId;
    title?: MonacoMenuTitle;
  }

  export const MenuId: {
    readonly EditorContext: IMonacoMenuId;
    readonly EditorContextPeek: IMonacoMenuId;
    readonly EditorContextCopy: IMonacoMenuId;
    readonly EditorContextShare: IMonacoMenuId;
  };

  export const MenuRegistry: {
    getMenuItems(id: IMonacoMenuId): IMonacoMenuItem[];
  };
}
