import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFilesMonacoContextMenuLocale,
  type FilesMonacoMenuItem,
  type FilesMonacoMenuRegistry,
} from "../src/files-workbench/filesMonacoContextMenuLocale.js";
import {
  FILES_MONACO_CONTEXT_MENU_COMMAND_KEYS,
  FILES_MONACO_CONTEXT_MENU_SUBMENU_KEYS,
  listFilesMonacoContextMenuLocaleKeys,
  resolveFilesMonacoContextMenuCommandKey,
  resolveFilesMonacoContextMenuSubmenuKey,
} from "../src/files-workbench/filesMonacoContextMenuLabels.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const EDITOR_CONTEXT_MENU_ID = { id: "EditorContext" };
const PEEK_SUBMENU_ID = { id: "EditorContextPeek" };

function createFakeRegistry(): FilesMonacoMenuRegistry & {
  append(menuId: { id: string }, item: FilesMonacoMenuItem): void;
} {
  const itemsByMenuId = new Map<string, FilesMonacoMenuItem[]>();
  return {
    append(menuId, item) {
      const items = itemsByMenuId.get(menuId.id) ?? [];
      items.push(item);
      itemsByMenuId.set(menuId.id, items);
    },
    getMenuItems(menuId) {
      return itemsByMenuId.get(menuId.id) ?? [];
    },
  };
}

test("右键菜单映射用到的语言键在中英文语言包里都存在", () => {
  for (const key of listFilesMonacoContextMenuLocaleKeys()) {
    assert.ok(zhCN[key], `zh-CN 缺少语言键 ${key}`);
    assert.ok(enUS[key], `en-US 缺少语言键 ${key}`);
  }
});

test("中文语言包真的翻译了右键菜单文案", () => {
  for (const [commandId, key] of Object.entries(FILES_MONACO_CONTEXT_MENU_COMMAND_KEYS)) {
    assert.notEqual(zhCN[key], enUS[key], `${commandId} 的中英文文案相同，未翻译`);
  }
  for (const [submenuId, key] of Object.entries(FILES_MONACO_CONTEXT_MENU_SUBMENU_KEYS)) {
    assert.notEqual(zhCN[key], enUS[key], `${submenuId} 的中英文文案相同，未翻译`);
  }
});

test("未登记的命令与子菜单保持 Monaco 原文", () => {
  assert.equal(resolveFilesMonacoContextMenuCommandKey("editor.action.notRegistered"), undefined);
  assert.equal(resolveFilesMonacoContextMenuSubmenuKey("EditorContextUnknown"), undefined);
});

test("按语言改写右键菜单标题，切换语言后同步刷新", () => {
  const registry = createFakeRegistry();
  const definitionCommand = { id: "editor.action.revealDefinition", title: "Go to Definition" };
  const unknownCommand = { id: "editor.action.notRegistered", title: "Some Future Action" };
  const peekSubmenu = { submenu: PEEK_SUBMENU_ID, title: "Peek" };
  registry.append(EDITOR_CONTEXT_MENU_ID, { command: definitionCommand });
  registry.append(EDITOR_CONTEXT_MENU_ID, { command: unknownCommand });
  registry.append(EDITOR_CONTEXT_MENU_ID, peekSubmenu);
  registry.append(PEEK_SUBMENU_ID, {
    command: { id: "editor.action.peekDefinition", title: "Peek Definition" },
  });

  applyFilesMonacoContextMenuLocale(registry, EDITOR_CONTEXT_MENU_ID, (key) => zhCN[key] ?? key);
  assert.equal(definitionCommand.title, "转到定义");
  assert.equal(peekSubmenu.title, "预览");
  assert.equal(unknownCommand.title, "Some Future Action");

  applyFilesMonacoContextMenuLocale(registry, EDITOR_CONTEXT_MENU_ID, (key) => enUS[key] ?? key);
  assert.equal(definitionCommand.title, "Go to Definition");
  assert.equal(peekSubmenu.title, "Peek");
});

test("子菜单里的命令项也会被本地化", () => {
  const registry = createFakeRegistry();
  const peekCommand = { id: "editor.action.peekDefinition", title: "Peek Definition" };
  registry.append(EDITOR_CONTEXT_MENU_ID, { submenu: PEEK_SUBMENU_ID, title: "Peek" });
  registry.append(PEEK_SUBMENU_ID, { command: peekCommand });

  applyFilesMonacoContextMenuLocale(registry, EDITOR_CONTEXT_MENU_ID, (key) => zhCN[key] ?? key);
  assert.equal(peekCommand.title, "预览定义");
});
