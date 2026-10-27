import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 资源管理器窗口的菜单栏（见 docs/specs/desktop-application-menu.md）。
 *
 * 应用菜单（文件/编辑/视图/窗口/帮助）面向主窗口的工作区界面；Windows/Linux
 * 会把 Menu.setApplicationMenu 的应用级菜单画进每个系统边框窗口。资源管理器
 * 窗口使用系统默认标题栏，创建选项必须带 autoHideMenuBar: true，否则监控
 * 窗口顶部会出现一组作用于主窗口的菜单条目。
 */

const windowSource = readFileSync(
  new URL("../src/main/resourceManagerWindow.ts", import.meta.url),
  "utf8",
);

test("资源管理器窗口创建选项包含 autoHideMenuBar，不显示应用菜单栏", () => {
  assert.match(
    windowSource,
    /new BrowserWindow\(\{[\s\S]*?autoHideMenuBar:\s*true[\s\S]*?\}\);/,
    "资源管理器窗口必须隐藏应用菜单栏，应用菜单只属于主窗口的工作区界面",
  );
});
