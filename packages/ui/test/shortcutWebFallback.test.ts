import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUT_COMMANDS } from "@zcode/shared";
import { matchesPrimaryShortcut } from "../src/lib/keyboardShortcuts.js";
import { isSamePhysicalBinding } from "../src/shortcuts/conflicts.js";

/**
 * Web 端的快捷键边界。
 *
 * Web 端没有宿主应用菜单，menu 通道命令不可改键，⌘N / ⌘O 由根级回退监听消费
 * （useRootPlatformEffects）。因此 window 通道的命令不能占用这两个键，
 * 否则同一按键会在 Web 端触发两个动作。
 *
 * 保存、另存为、全部保存、新建文件、编辑器内查找替换都是 window 通道命令，
 * 桌面与 Web 走同一套分发，键位同样可在设置里改。
 */

const APPLE = { platform: "MacIntel" };
const WINDOWS = { platform: "Win32" };

/** Web 端根级回退监听消费的键（新建任务 / 打开工作区）。 */
const WEB_ROOT_FALLBACK_KEYS = ["n", "o"] as const;

test("Web 根级回退键不被 window 通道命令的默认键占用", () => {
  for (const entry of SHORTCUT_COMMANDS) {
    if (entry.channel !== "window") {
      continue;
    }
    for (const binding of entry.defaultBindings) {
      for (const key of WEB_ROOT_FALLBACK_KEYS) {
        for (const platformInfo of [APPLE, WINDOWS]) {
          assert.equal(
            isSamePhysicalBinding(binding, `CmdOrCtrl+${key}`, { platformInfo }),
            false,
            `${entry.id} 的默认键 ${binding} 与 Web 根级回退键 CmdOrCtrl+${key} 撞了`,
          );
        }
      }
    }
  }
});

test("带 Alt 的组合不触发 Web 根级回退", () => {
  // 新建文件用 ⌥⌘N；回退监听只认纯主修饰键，两者不重叠。
  const altCmdN = {
    key: "n",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: true,
  };
  assert.equal(matchesPrimaryShortcut(altCmdN, "n", APPLE), false);

  const altCtrlN = { ...altCmdN, metaKey: false, ctrlKey: true };
  assert.equal(matchesPrimaryShortcut(altCtrlN, "n", WINDOWS), false);

  // 纯主修饰键仍然命中回退：回退监听本身没被破坏。
  assert.equal(matchesPrimaryShortcut({ ...altCmdN, altKey: false }, "n", APPLE), true);
  assert.equal(matchesPrimaryShortcut({ ...altCtrlN, altKey: false }, "n", WINDOWS), true);
});

test("保存与新建命令走 window 通道，桌面与 Web 行为一致", () => {
  const byId = new Map(SHORTCUT_COMMANDS.map((entry) => [entry.id, entry]));
  const expected: Record<string, string[]> = {
    saveFile: ["CmdOrCtrl+s"],
    saveFileAs: ["CmdOrCtrl+Shift+s"],
    saveAllFiles: ["CmdOrCtrl+Alt+s"],
    newFile: ["CmdOrCtrl+Alt+n"],
    findReplaceInEditor: ["CmdOrCtrl+Alt+f"],
  };
  for (const [id, bindings] of Object.entries(expected)) {
    assert.deepEqual(byId.get(id)?.defaultBindings, bindings, `${id} 的默认键不对`);
    assert.equal(byId.get(id)?.channel, "window", `${id} 必须走 window 通道`);
  }
});
