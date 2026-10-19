import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUT_COMMANDS, type WorkspaceFileEntry } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  matchesShortcutBinding,
  resolveEffectiveShortcutBindings,
} from "../src/shortcuts/bindings.js";
import { checkShortcutBindingConflict } from "../src/shortcuts/conflicts.js";
import {
  COMMAND_CENTER_LAUNCH_SCOPE,
  resolveCommandCenterLaunchScope,
} from "../src/command-center/commandCenterLaunchScope.js";
import {
  buildCommandCenterFileCandidates,
  filterCommandCenterFileRows,
} from "../src/command-center/commandCenterFileRows.js";

const APPLE = { platform: "MacIntel" };
const WINDOWS = { platform: "Win32" };

function keyEvent(overrides: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}) {
  return {
    key: overrides.key,
    code: overrides.key.length === 1 ? `Key${overrides.key.toUpperCase()}` : undefined,
    metaKey: overrides.metaKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    altKey: overrides.altKey ?? false,
  };
}

test("命令中心三个入口各有独立默认键，全表默认键不重复", () => {
  const byId = new Map(SHORTCUT_COMMANDS.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get("openCommandCenter")?.defaultBindings, ["CmdOrCtrl+k"]);
  assert.deepEqual(byId.get("openQuickOpen")?.defaultBindings, ["CmdOrCtrl+p"]);
  assert.deepEqual(byId.get("openCommandPalette")?.defaultBindings, ["CmdOrCtrl+Shift+p"]);
  assert.equal(byId.get("openQuickOpen")?.channel, "window");
  assert.equal(byId.get("openCommandPalette")?.channel, "window");

  const seen = new Set<string>();
  for (const entry of SHORTCUT_COMMANDS) {
    for (const binding of entry.defaultBindings) {
      assert.equal(seen.has(binding), false, `默认键重复：${binding}`);
      seen.add(binding);
    }
  }
});

test("生效表包含新入口命令，用户覆盖按整组替换", () => {
  const effective = resolveEffectiveShortcutBindings(undefined);
  assert.deepEqual(effective.openCommandCenter, ["CmdOrCtrl+k"]);
  assert.deepEqual(effective.openQuickOpen, ["CmdOrCtrl+p"]);
  assert.deepEqual(effective.openCommandPalette, ["CmdOrCtrl+Shift+p"]);

  const overridden = resolveEffectiveShortcutBindings({
    openQuickOpen: ["CmdOrCtrl+Alt+p"],
  });
  assert.deepEqual(overridden.openQuickOpen, ["CmdOrCtrl+Alt+p"]);
  // 整组替换不影响其它命令
  assert.deepEqual(overridden.openCommandPalette, ["CmdOrCtrl+Shift+p"]);
});

test("CmdOrCtrl+p 不再是保留键，改绑走占用抢绑而不是直接拒绝", () => {
  assert.equal(checkShortcutBindingConflict("openQuickOpen", "CmdOrCtrl+p"), null);

  const conflict = checkShortcutBindingConflict("openSettings", "CmdOrCtrl+p");
  assert.equal(conflict?.kind, "occupied");
  assert.equal(conflict?.ownerCommandId, "openQuickOpen");

  // 其它编辑类保留键仍然直接拒绝
  assert.equal(checkShortcutBindingConflict("openSettings", "CmdOrCtrl+c")?.kind, "reserved");
  assert.equal(checkShortcutBindingConflict("openSettings", "CmdOrCtrl+v")?.kind, "reserved");
});

test("CmdOrCtrl+Shift+p 归命令面板独占，不产生同键双动作", () => {
  assert.equal(checkShortcutBindingConflict("openCommandPalette", "CmdOrCtrl+Shift+p"), null);

  const conflict = checkShortcutBindingConflict("openQuickOpen", "CmdOrCtrl+Shift+p");
  assert.equal(conflict?.kind, "occupied");
  assert.equal(conflict?.ownerCommandId, "openCommandPalette");
});

test("Cmd+P / Ctrl+P 命中快速打开，Cmd+Shift+P 命中命令面板", () => {
  const appleCmdP = keyEvent({ key: "p", metaKey: true });
  assert.equal(matchesShortcutBinding(appleCmdP, "CmdOrCtrl+p", APPLE), true);
  assert.equal(matchesShortcutBinding(appleCmdP, "CmdOrCtrl+p", WINDOWS), false);

  const windowsCtrlP = keyEvent({ key: "p", ctrlKey: true });
  assert.equal(matchesShortcutBinding(windowsCtrlP, "CmdOrCtrl+p", WINDOWS), true);
  assert.equal(matchesShortcutBinding(windowsCtrlP, "CmdOrCtrl+p", APPLE), false);

  const appleCmdShiftP = keyEvent({ key: "P", metaKey: true, shiftKey: true });
  assert.equal(matchesShortcutBinding(appleCmdShiftP, "CmdOrCtrl+Shift+p", APPLE), true);
  assert.equal(matchesShortcutBinding(appleCmdShiftP, "CmdOrCtrl+p", APPLE), false);
});

test("三个入口映射到各自的初始范围", () => {
  assert.equal(resolveCommandCenterLaunchScope("openCommandCenter"), "all");
  assert.equal(resolveCommandCenterLaunchScope("openQuickOpen"), "files");
  assert.equal(resolveCommandCenterLaunchScope("openCommandPalette"), "commands");
  assert.deepEqual(COMMAND_CENTER_LAUNCH_SCOPE, {
    openCommandCenter: "all",
    openQuickOpen: "files",
    openCommandPalette: "commands",
  });
});

function fileEntry(entry: Partial<WorkspaceFileEntry> & { name: string }): WorkspaceFileEntry {
  return {
    path: `/w/${entry.name}`,
    relativePath: entry.name,
    type: "file",
    ...entry,
  };
}

test("快速打开按模糊打分匹配文件：非连续子串也能命中", () => {
  const candidates = buildCommandCenterFileCandidates([
    fileEntry({ name: "markdown-code.ts" }),
    fileEntry({ name: "app.tsx" }),
    fileEntry({ name: "index.ts" }),
  ]);

  const rows = filterCommandCenterFileRows(candidates, "mdc");
  assert.deepEqual(
    rows.map((row) => row.relativePath),
    ["markdown-code.ts"],
  );
});

test("快速打开只列文件，目录不进结果；空查询不列文件", () => {
  const candidates = buildCommandCenterFileCandidates([
    fileEntry({ name: "app.tsx" }),
    fileEntry({ name: "src", type: "directory" }),
  ]);

  assert.deepEqual(
    filterCommandCenterFileRows(candidates, "app").map((row) => row.relativePath),
    ["app.tsx"],
  );
  assert.deepEqual(filterCommandCenterFileRows(candidates, ""), []);
});

test("快速打开按打分排序：前缀命中排在子串命中之前", () => {
  const candidates = buildCommandCenterFileCandidates([
    fileEntry({ name: "app-store.ts" }),
    fileEntry({ name: "app.tsx" }),
  ]);

  const rows = filterCommandCenterFileRows(candidates, "app");
  assert.deepEqual(
    rows.map((row) => row.relativePath),
    ["app.tsx", "app-store.ts"],
  );
});

test("两个新入口提供中英文设置页文案", () => {
  assert.equal(zhCN["settings.shortcuts.command.openQuickOpen"], "快速打开（转到文件）");
  assert.equal(enUS["settings.shortcuts.command.openQuickOpen"], "Quick Open (Go to File)");
  assert.equal(zhCN["settings.shortcuts.command.openCommandPalette"], "命令面板");
  assert.equal(enUS["settings.shortcuts.command.openCommandPalette"], "Command Palette");
});
