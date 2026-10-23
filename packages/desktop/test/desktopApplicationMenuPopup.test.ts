import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Menu, type BrowserWindow } from "electron";
import { showApplicationMenu } from "../src/main/desktopApplicationMenuPopup.js";
import { setDesktopMenuContextForWindow } from "../src/main/desktopMenuContext.js";
import { DESKTOP_MENU_ITEM_IDS } from "../src/main/desktopMenuItems.js";
import { __clearMenu, __setFocusedWindow, __setWindows } from "./helpers/electronStub.mjs";

beforeEach(() => {
  __setWindows([1, 2]);
  __setFocusedWindow(1);
  __clearMenu();
});

function windowStub(id: number, destroyed = false): BrowserWindow {
  return { id, isDestroyed: () => destroyed } as BrowserWindow;
}

test("弹出同一份应用菜单，并先应用来源窗口而非焦点窗口的上下文", () => {
  const saveItem = { visible: false, enabled: false };
  const sourceWindow = windowStub(2);
  let popupCount = 0;
  const menu = {
    getMenuItemById: (id: string) => (id === DESKTOP_MENU_ITEM_IDS.fileSave ? saveItem : null),
    popup: (options: Electron.PopupOptions) => {
      popupCount++;
      assert.equal(options.window, sourceWindow);
      assert.equal(saveItem.visible, true);
      assert.equal(saveItem.enabled, true);
    },
  };
  Menu.setApplicationMenu(menu as unknown as Electron.Menu);
  setDesktopMenuContextForWindow(1, { view: "tasks", editor: null });
  setDesktopMenuContextForWindow(2, {
    view: "files",
    editor: { hasActiveEditor: true, canSave: true, dirtyFileCount: 1 },
  });
  assert.equal(saveItem.visible, false);

  showApplicationMenu(sourceWindow);

  assert.equal(Menu.getApplicationMenu(), menu);
  assert.equal(popupCount, 1);
});

test("来源窗口没有上下文时，不沿用其它窗口的文件菜单状态", () => {
  const saveItem = { visible: true, enabled: true };
  Menu.setApplicationMenu({
    getMenuItemById: (id: string) => (id === DESKTOP_MENU_ITEM_IDS.fileSave ? saveItem : null),
    popup: () => assert.equal(saveItem.visible, false),
  } as unknown as Electron.Menu);

  showApplicationMenu(windowStub(3));

  assert.equal(saveItem.enabled, false);
});

test("没有来源窗口、窗口已销毁或菜单尚未建立时不弹出", () => {
  let popupCount = 0;
  Menu.setApplicationMenu({ popup: () => popupCount++ } as unknown as Electron.Menu);
  showApplicationMenu(null);
  showApplicationMenu(undefined);
  showApplicationMenu(windowStub(2, true));
  assert.equal(popupCount, 0);

  __clearMenu();
  assert.doesNotThrow(() => showApplicationMenu(windowStub(2)));
});
