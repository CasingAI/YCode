import assert from "node:assert/strict";
import test from "node:test";
import { isShortcutCommandListed } from "../src/settings/shortcutCommandVisibility.js";

/**
 * 设置页命令行的可见性。
 *
 * 「关闭编辑器」依赖宿主应用菜单，只在桌面端存在；Web 端展示它会让用户以为
 * 按 ⌘W 会关编辑器，而 Web 端的 ⌘W 是浏览器的关闭标签页。
 */

test("桌面端展示关闭编辑器", () => {
  assert.equal(isShortcutCommandListed("closeActiveContext", { isDesktop: true }), true);
});

test("Web 端不展示关闭编辑器", () => {
  assert.equal(isShortcutCommandListed("closeActiveContext", { isDesktop: false }), false);
});

test("内部保留键不展示", () => {
  assert.equal(isShortcutCommandListed("openOnboarding", { isDesktop: true }), false);
  assert.equal(isShortcutCommandListed("toggleInterfaceMode", { isDesktop: true }), false);
});

test("两端都支持的命令都展示", () => {
  for (const commandId of ["saveFile", "newTask", "openWorkspace", "findInTask"] as const) {
    assert.equal(isShortcutCommandListed(commandId, { isDesktop: true }), true);
    assert.equal(isShortcutCommandListed(commandId, { isDesktop: false }), true);
  }
});
