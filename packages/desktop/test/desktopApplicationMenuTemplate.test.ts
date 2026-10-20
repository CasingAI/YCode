import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { buildApplicationMenuTemplate } from "../src/main/desktopApplicationMenuTemplate.js";
import { DESKTOP_MENU_ITEM_IDS } from "../src/main/desktopMenuItems.js";

/**
 * 应用菜单模板的形状约束：
 * 菜单条目随界面增删靠 visible，键位归属靠 accelerator / registerAccelerator，
 * 这里锁住这几条规则，避免后续改动把「隐藏但仍触发」的坑带回来。
 */

type MenuTemplate = Electron.MenuItemConstructorOptions[];

function build(overrides?: {
  shortcutBindings?: Record<string, string[]>;
  disableShortcutAccelerators?: boolean;
}): MenuTemplate {
  return buildApplicationMenuTemplate({
    currentApplicationLocale: "zh-CN",
    executeDesktopCommand: async () => undefined,
    executeUiCommand: () => undefined,
    ...overrides,
  });
}

function submenuOf(template: MenuTemplate, label: string): MenuTemplate {
  const menu = template.find((entry) => entry.label === label);
  assert.ok(menu?.submenu, `菜单里缺少「${label}」`);
  return menu.submenu as MenuTemplate;
}

function itemOf(template: MenuTemplate, id: string): Electron.MenuItemConstructorOptions {
  const item = template.find((entry) => entry.id === id);
  assert.ok(item, `菜单里缺少条目 ${id}`);
  return item;
}

describe("应用菜单模板", () => {
  let platform: string;

  beforeEach(() => {
    platform = process.platform;
  });

  it("macOS 的关闭编辑器条目关掉隐藏时的 accelerator 触发", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const file = submenuOf(build(), "文件");
      const closeEditor = itemOf(file, DESKTOP_MENU_ITEM_IDS.fileCloseEditor);

      assert.equal(closeEditor.accelerator, "CmdOrCtrl+W");
      // Electron 的 acceleratorWorksWhenHidden 默认是 true：
      // 不显式关掉，条目在任务界面隐藏后按 Cmd+W 仍会触发。
      assert.equal(closeEditor.acceleratorWorksWhenHidden, false);
      assert.equal(closeEditor.visible, false);
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("非 macOS 保留关闭窗口条目", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const file = submenuOf(build(), "文件");
      assert.ok(
        file.some((entry) => entry.id === DESKTOP_MENU_ITEM_IDS.fileCloseWindow),
        "非 macOS 应当保留关闭窗口条目",
      );
      assert.equal(
        file.some((entry) => entry.id === DESKTOP_MENU_ITEM_IDS.fileCloseEditor),
        false,
      );
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("保存类条目默认隐藏且只显示键位不向系统注册", () => {
    const file = submenuOf(build(), "文件");

    for (const id of [
      DESKTOP_MENU_ITEM_IDS.fileSave,
      DESKTOP_MENU_ITEM_IDS.fileSaveAs,
      DESKTOP_MENU_ITEM_IDS.fileSaveAll,
    ]) {
      const item = itemOf(file, id);
      assert.equal(item.visible, false, `${id} 默认应当隐藏`);
      assert.equal(item.registerAccelerator, false, `${id} 不应向系统注册 accelerator`);
      assert.ok(item.accelerator, `${id} 应当显示键位`);
    }
  });

  it("撤销/重做与查找条目只显示键位，交给渲染进程执行", () => {
    const edit = submenuOf(build(), "编辑");

    const undo = itemOf(edit, DESKTOP_MENU_ITEM_IDS.editUndo);
    const redo = itemOf(edit, DESKTOP_MENU_ITEM_IDS.editRedo);
    const find = itemOf(edit, DESKTOP_MENU_ITEM_IDS.editFind);
    const findReplace = itemOf(edit, DESKTOP_MENU_ITEM_IDS.editFindReplace);

    assert.equal(undo.accelerator, "CmdOrCtrl+Z");
    assert.equal(redo.accelerator, "CmdOrCtrl+Shift+Z");
    assert.equal(find.accelerator, "CmdOrCtrl+F");
    assert.equal(findReplace.accelerator, "CmdOrCtrl+Alt+F");

    for (const item of [undo, redo, find, findReplace]) {
      assert.equal(item.registerAccelerator, false);
    }
    assert.equal(find.visible, false);
    assert.equal(findReplace.visible, false);
  });

  it("菜单键位跟随用户快捷键设置", () => {
    const file = submenuOf(
      // 用户键位以规范形式保存（单字母键小写），菜单展示时统一大写。
      build({ shortcutBindings: { saveFile: ["CmdOrCtrl+Alt+s"] } }),
      "文件",
    );
    const save = itemOf(file, DESKTOP_MENU_ITEM_IDS.fileSave);
    assert.equal(save.accelerator, "CmdOrCtrl+Alt+S");
  });

  it("查找条目的键位跟随「在任务中查找」的设置", () => {
    const edit = submenuOf(
      build({ shortcutBindings: { findInTask: ["CmdOrCtrl+Shift+f"] } }),
      "编辑",
    );
    assert.equal(itemOf(edit, DESKTOP_MENU_ITEM_IDS.editFind).accelerator, "CmdOrCtrl+Shift+F");
  });

  it("用户把键位清空时菜单不显示键位", () => {
    const file = submenuOf(build({ shortcutBindings: { saveFile: [] } }), "文件");
    const save = itemOf(file, DESKTOP_MENU_ITEM_IDS.fileSave);
    assert.equal(save.accelerator, undefined);
  });

  it("快捷键录制态摘掉可配置键位", () => {
    const file = submenuOf(build({ disableShortcutAccelerators: true }), "文件");
    const save = itemOf(file, DESKTOP_MENU_ITEM_IDS.fileSave);
    assert.equal(save.accelerator, undefined);
  });

  it("顶层菜单包含文件、编辑、视图、窗口、帮助", () => {
    const labels = build().map((entry) => entry.label);
    for (const label of ["文件", "编辑", "视图", "窗口", "帮助"]) {
      assert.ok(labels.includes(label), `顶层菜单缺少「${label}」`);
    }
  });
});
