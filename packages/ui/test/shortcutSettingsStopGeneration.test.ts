import assert from "node:assert/strict";
import test from "node:test";
import { parseShortcutBinding, serializeShortcutBinding, SHORTCUT_COMMANDS } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  matchesShortcutBinding,
  resolveEffectiveShortcutBindings,
} from "../src/shortcuts/bindings.js";
import {
  buildShortcutOverridesAfterToggle,
  checkShortcutBindingConflict,
} from "../src/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "../src/shortcuts/label.js";

const stopGenerationCommand = SHORTCUT_COMMANDS.find((entry) => entry.id === "stopGeneration");

test("停止生成进入普通命令表并默认绑定 Escape", () => {
  assert.ok(stopGenerationCommand);
  assert.equal(stopGenerationCommand.channel, "window");
  assert.equal(stopGenerationCommand.scope, undefined);
  assert.equal(stopGenerationCommand.settingsControl, "toggle");
  assert.deepEqual(stopGenerationCommand.defaultBindings, ["Escape"]);
});

test("Escape 参与解析、序列化和展示，但裸键不匹配额外修饰键", () => {
  const parsed = parseShortcutBinding("Escape");
  assert.ok(parsed);
  assert.equal(serializeShortcutBinding(parsed), "Escape");
  assert.equal(formatShortcutBindingLabel("Escape"), "Esc");

  const event = {
    key: "Escape",
    code: "Escape",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  assert.equal(matchesShortcutBinding(event, "Escape"), true);
  assert.equal(matchesShortcutBinding({ ...event, metaKey: true }, "Escape"), false);
  assert.equal(matchesShortcutBinding({ ...event, ctrlKey: true }, "Escape"), false);
  assert.equal(matchesShortcutBinding({ ...event, shiftKey: true }, "Escape"), false);
});

test("停止生成的 Switch 遵循显式空数组语义，旧版非空覆盖归一回默认", () => {
  assert.deepEqual(resolveEffectiveShortcutBindings(undefined).stopGeneration, ["Escape"]);
  assert.deepEqual(resolveEffectiveShortcutBindings({ stopGeneration: [] }).stopGeneration, []);
  assert.deepEqual(
    resolveEffectiveShortcutBindings({ stopGeneration: ["CmdOrCtrl+x"] }).stopGeneration,
    ["Escape"],
  );
  assert.deepEqual(
    resolveEffectiveShortcutBindings({ stopGeneration: ["NotAKey"] }).stopGeneration,
    ["Escape"],
  );
  assert.deepEqual(
    resolveEffectiveShortcutBindings({ stopGeneration: ["Escape", "NotAKey"] }).stopGeneration,
    ["Escape"],
  );
  assert.deepEqual(
    buildShortcutOverridesAfterToggle(
      { stopGeneration: [], other: ["CmdOrCtrl+k"] },
      "stopGeneration",
      false,
    ),
    { stopGeneration: [], other: ["CmdOrCtrl+k"] },
  );
  assert.deepEqual(
    buildShortcutOverridesAfterToggle(
      { stopGeneration: [], other: ["CmdOrCtrl+k"] },
      "stopGeneration",
      true,
    ),
    { other: ["CmdOrCtrl+k"] },
  );
});

test("停止生成默认键参与普通命令冲突检测且不被保留键拦截", () => {
  assert.equal(checkShortcutBindingConflict("stopGeneration", "Escape"), null);

  const conflict = checkShortcutBindingConflict("openCommandCenter", "Escape");
  assert.equal(conflict?.kind, "occupied");
  assert.equal(conflict?.ownerCommandId, "stopGeneration");
  assert.equal(
    checkShortcutBindingConflict("openCommandCenter", "Escape", { stopGeneration: [] }),
    null,
  );
});

test("停止生成提供中英文普通命令文案，不保留固定区文案", () => {
  assert.equal(zhCN["settings.shortcuts.command.stopGeneration"], "停止生成");
  assert.equal(enUS["settings.shortcuts.command.stopGeneration"], "Stop generation");
  assert.equal(zhCN["settings.shortcuts.toggleAria"], "切换「{command}」快捷键");
  assert.equal(enUS["settings.shortcuts.toggleAria"], 'Toggle shortcut for "{command}"');
  assert.equal("settings.shortcuts.fixedSectionTitle" in enUS, false);
  assert.equal("settings.shortcuts.fixedStopGeneration" in enUS, false);
  assert.equal("settings.shortcuts.configurableSectionTitle" in enUS, false);
  assert.equal("settings.shortcuts.fixedSectionTitle" in zhCN, false);
  assert.equal("settings.shortcuts.fixedStopGeneration" in zhCN, false);
  assert.equal("settings.shortcuts.configurableSectionTitle" in zhCN, false);
});
