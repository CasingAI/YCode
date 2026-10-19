import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUT_COMMANDS, type WorkspaceFileEntry } from "@zcode/shared";
import {
  getWorkspaceFileSearchCandidateScore,
  mapWorkspaceFileEntriesToSearchCandidates,
} from "@zcode/shared/workspaceFileSearch";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  matchesShortcutBinding,
  resolveEffectiveShortcutBindings,
} from "../src/shortcuts/bindings.js";
import { checkShortcutBindingConflict } from "../src/shortcuts/conflicts.js";
import {
  findExactWorkspaceFileEntry,
  normalizeWorkspaceFilePathQuery,
} from "../src/workspace-file-tree/workspaceFilePathMatch.js";
import { createFilesEditorStore } from "../src/files-workbench/filesEditorStore.js";

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

test("⌘P 是独立的快速打开命令，命令中心入口保持双默认", () => {
  const byId = new Map(SHORTCUT_COMMANDS.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get("openQuickOpen")?.defaultBindings, ["CmdOrCtrl+p"]);
  assert.equal(byId.get("openQuickOpen")?.channel, "window");
  // 命令中心入口不受快速打开影响
  assert.deepEqual(byId.get("openCommandCenter")?.defaultBindings, [
    "CmdOrCtrl+k",
    "CmdOrCtrl+Shift+p",
  ]);
});

test("全表默认键不重复，快捷键不产生同键双动作", () => {
  const seen = new Set<string>();
  for (const entry of SHORTCUT_COMMANDS) {
    for (const binding of entry.defaultBindings) {
      assert.equal(seen.has(binding), false, `默认键重复：${binding}`);
      seen.add(binding);
    }
  }
});

test("生效表包含快速打开命令，用户覆盖按整组替换", () => {
  const effective = resolveEffectiveShortcutBindings(undefined);
  assert.deepEqual(effective.openQuickOpen, ["CmdOrCtrl+p"]);
  assert.deepEqual(effective.openCommandCenter, ["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"]);

  const overridden = resolveEffectiveShortcutBindings({ openQuickOpen: ["CmdOrCtrl+Alt+p"] });
  assert.deepEqual(overridden.openQuickOpen, ["CmdOrCtrl+Alt+p"]);
  assert.deepEqual(overridden.openCommandCenter, ["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"]);
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

test("Cmd+P / Ctrl+P 命中快速打开", () => {
  const appleCmdP = keyEvent({ key: "p", metaKey: true });
  assert.equal(matchesShortcutBinding(appleCmdP, "CmdOrCtrl+p", APPLE), true);
  assert.equal(matchesShortcutBinding(appleCmdP, "CmdOrCtrl+p", WINDOWS), false);

  const windowsCtrlP = keyEvent({ key: "p", ctrlKey: true });
  assert.equal(matchesShortcutBinding(windowsCtrlP, "CmdOrCtrl+p", WINDOWS), true);
  assert.equal(matchesShortcutBinding(windowsCtrlP, "CmdOrCtrl+p", APPLE), false);
});

test("路径归一化：去空白、去成对引号、统一分隔符", () => {
  assert.equal(normalizeWorkspaceFilePathQuery("  src/a.ts  "), "src/a.ts");
  assert.equal(normalizeWorkspaceFilePathQuery('"src/a.ts"'), "src/a.ts");
  assert.equal(normalizeWorkspaceFilePathQuery("'src/a.ts'"), "src/a.ts");
  assert.equal(normalizeWorkspaceFilePathQuery("src\\a.ts"), "src/a.ts");
  // 不成对的引号不处理
  assert.equal(normalizeWorkspaceFilePathQuery('"src/a.ts'), '"src/a.ts');
});

function fileEntry(entry: Partial<WorkspaceFileEntry> & { name: string }): WorkspaceFileEntry {
  return {
    path: `/w/${entry.name}`,
    relativePath: entry.name,
    type: "file",
    ...entry,
  };
}

const WORKSPACE_FILES: WorkspaceFileEntry[] = [
  fileEntry({ name: "src/hooks/useFoo.ts" }),
  fileEntry({ name: "src/app.tsx" }),
  fileEntry({ name: "README.md" }),
];

test("路径识别：绝对路径与相对路径都能精确命中", () => {
  const byAbsolute = findExactWorkspaceFileEntry(WORKSPACE_FILES, "/w/src/app.tsx");
  assert.equal(byAbsolute?.relativePath, "src/app.tsx");

  const byRelative = findExactWorkspaceFileEntry(WORKSPACE_FILES, "src/hooks/useFoo.ts");
  assert.equal(byRelative?.relativePath, "src/hooks/useFoo.ts");

  // 相对路径比较忽略大小写
  const byCaseInsensitive = findExactWorkspaceFileEntry(WORKSPACE_FILES, "SRC/APP.TSX");
  assert.equal(byCaseInsensitive?.relativePath, "src/app.tsx");
});

test("路径识别：带引号的粘贴与未命中路径", () => {
  assert.equal(
    findExactWorkspaceFileEntry(WORKSPACE_FILES, '"src/app.tsx"')?.relativePath,
    "src/app.tsx",
  );
  assert.equal(findExactWorkspaceFileEntry(WORKSPACE_FILES, "src/missing.ts"), undefined);
  assert.equal(findExactWorkspaceFileEntry(WORKSPACE_FILES, "  "), undefined);
});

test("路径识别：普通关键词不是路径，不误判成精确命中", () => {
  assert.equal(findExactWorkspaceFileEntry(WORKSPACE_FILES, "app"), undefined);
  assert.equal(findExactWorkspaceFileEntry(WORKSPACE_FILES, "useFoo"), undefined);
});

test("共享打分：精确路径命中排第一，非精确命中保持模糊排序", () => {
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(WORKSPACE_FILES);

  const exact = getWorkspaceFileSearchCandidateScore(
    candidates.find((candidate) => candidate.relativePath === "src/app.tsx")!,
    "src/app.tsx",
  );
  const fuzzy = getWorkspaceFileSearchCandidateScore(
    candidates.find((candidate) => candidate.relativePath === "src/hooks/useFoo.ts")!,
    "useFoo",
  );
  assert.ok(exact !== null);
  assert.ok(fuzzy !== null);
  // 分数越小越靠前：精确命中必须压过模糊命中
  assert.ok(exact < fuzzy, `精确命中分数 ${exact} 应小于模糊命中分数 ${fuzzy}`);
});

test("聚焦请求走 filesEditorStore：请求号递增，初始为 0", () => {
  const store = createFilesEditorStore();
  assert.equal(store.getState().searchFocusRequestId, 0);

  store.getState().requestSearchFocus();
  assert.equal(store.getState().searchFocusRequestId, 1);

  store.getState().requestSearchFocus();
  assert.equal(store.getState().searchFocusRequestId, 2);
});

test("快速打开提供中英文设置页文案", () => {
  assert.equal(zhCN["settings.shortcuts.command.openQuickOpen"], "快速打开文件");
  assert.equal(enUS["settings.shortcuts.command.openQuickOpen"], "Quick Open (Go to File)");
});
