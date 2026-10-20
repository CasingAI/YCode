import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { DesktopMenuContext } from "@zcode/shared";
import {
  __clearMenu,
  __setFocusedWindow,
  __setMenu,
  __setWindows,
} from "./helpers/electronStub.mjs";
import {
  applyDesktopMenuContext,
  applyFocusedDesktopMenuContext,
  clearDesktopMenuContextForWindow,
  setDesktopMenuContextForWindow,
} from "../src/main/desktopMenuContext.js";
import {
  DESKTOP_MENU_FILES_ONLY_ITEM_IDS,
  DESKTOP_MENU_ITEM_IDS,
} from "../src/main/desktopMenuItems.js";

/**
 * 桌面菜单的上下文投影：
 * macOS 应用菜单全局只有一份，条目显隐/置灰必须跟随焦点窗口的上下文。
 */

interface StubMenuItem {
  id: string;
  visible?: boolean;
  enabled?: boolean;
}

let menuItems: StubMenuItem[] = [];

function itemById(id: string): StubMenuItem {
  const item = menuItems.find((entry) => entry.id === id);
  assert.ok(item, `菜单里缺少条目 ${id}`);
  return item;
}

function filesContext(overrides?: Partial<DesktopMenuContext>): DesktopMenuContext {
  return {
    view: "files",
    editor: {
      hasActiveEditor: true,
      canSave: true,
      dirtyFileCount: 0,
    },
    ...overrides,
  } as DesktopMenuContext;
}

describe("桌面菜单上下文投影", () => {
  beforeEach(() => {
    menuItems = [
      ...DESKTOP_MENU_FILES_ONLY_ITEM_IDS.map((id) => ({ id, visible: false })),
      { id: DESKTOP_MENU_ITEM_IDS.fileNewTask, visible: true },
    ];
    __setMenu(menuItems);
    __setWindows([1]);
    __setFocusedWindow(1);
  });

  it("文件界面才显示文件专属条目，并放行可保存的编辑器", () => {
    applyDesktopMenuContext(filesContext());

    for (const id of DESKTOP_MENU_FILES_ONLY_ITEM_IDS) {
      assert.equal(itemById(id).visible, true, `${id} 应当在文件界面可见`);
    }
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSave).enabled, true);
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSaveAs).enabled, true);
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileCloseEditor).enabled, true);
  });

  it("非文件界面隐藏文件专属条目并把编辑器条目置灰", () => {
    applyDesktopMenuContext(filesContext());
    applyDesktopMenuContext({ view: "tasks", editor: null });

    for (const id of DESKTOP_MENU_FILES_ONLY_ITEM_IDS) {
      assert.equal(itemById(id).visible, false, `${id} 应当在非文件界面隐藏`);
    }
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSave).enabled, false);
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileCloseEditor).enabled, false);
    // 非文件专属条目不受影响
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileNewTask).visible, true);
  });

  it("没有上下文时按不在文件界面处理", () => {
    applyDesktopMenuContext(filesContext());
    applyDesktopMenuContext(null);

    for (const id of DESKTOP_MENU_FILES_ONLY_ITEM_IDS) {
      assert.equal(itemById(id).visible, false);
    }
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSave).enabled, false);
  });

  it("保存类条目的可用性跟随编辑器能力", () => {
    applyDesktopMenuContext(
      filesContext({
        editor: {
          hasActiveEditor: true,
          canSave: false,
          dirtyFileCount: 2,
        },
      }),
    );

    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSave).enabled, false);
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSaveAs).enabled, false);
    // 全部保存只看有没有脏文件
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSaveAll).enabled, true);
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileCloseEditor).enabled, true);
  });

  it("没有脏文件时全部保存置灰", () => {
    applyDesktopMenuContext(filesContext());
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSaveAll).enabled, false);
  });

  it("没有可关闭标签时关闭编辑器置灰", () => {
    applyDesktopMenuContext(
      filesContext({
        editor: {
          hasActiveEditor: false,
          canSave: false,
          dirtyFileCount: 0,
        },
      }),
    );

    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileCloseEditor).enabled, false);
  });

  it("菜单跟随焦点窗口切换", () => {
    __setWindows([1, 2]);
    setDesktopMenuContextForWindow(1, filesContext());
    setDesktopMenuContextForWindow(2, { view: "tasks", editor: null });

    __setFocusedWindow(1);
    applyFocusedDesktopMenuContext();
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSave).visible, true);

    __setFocusedWindow(2);
    applyFocusedDesktopMenuContext();
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSave).visible, false);
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSave).enabled, false);
  });

  it("窗口关闭后清理它的上下文", () => {
    __setWindows([1, 2]);
    setDesktopMenuContextForWindow(1, filesContext());
    setDesktopMenuContextForWindow(2, { view: "tasks", editor: null });

    __setFocusedWindow(2);
    clearDesktopMenuContextForWindow(2);

    // 焦点窗口已经没有上下文 → 回落到「不在文件界面」
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSave).visible, false);
    assert.equal(itemById(DESKTOP_MENU_ITEM_IDS.fileSave).enabled, false);
  });

  it("菜单尚未构建时投影不报错", () => {
    __clearMenu();
    assert.doesNotThrow(() => applyDesktopMenuContext(filesContext()));
  });
});
