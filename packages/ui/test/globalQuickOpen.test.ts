import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUT_COMMANDS, type WorkspaceFileEntry } from "@zcode/shared";
import {
  filterWorkspaceFileSearchCandidates,
  getWorkspaceFileSearchCandidateScore,
  mapWorkspaceFileEntriesToSearchCandidates,
  normalizeWorkspaceFileSearchQuery,
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
import { buildSearchCenterOpenedFiles } from "../src/search-center/searchCenterOpenedFiles.js";
import {
  INITIAL_SEARCH_OVERLAY_STATE,
  openSearchCenter,
  resolveSearchCenterRows,
  resolveSearchCenterSelection,
  setQuickPickOpen,
  setSearchCenterOpen,
  toggleQuickPick,
} from "../src/search-center/searchCenterState.js";
import type { FilesBuffer } from "../src/files-workbench/filesEditorTypes.js";

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

test("归一化发生在真实打分链路之前：带引号/反斜杠的粘贴按精确路径命中", () => {
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(WORKSPACE_FILES);
  const appCandidate = candidates.find((candidate) => candidate.relativePath === "src/app.tsx")!;

  // 只测辅助函数会漏掉「归一化没接进打分链路」这类回归
  assert.equal(getWorkspaceFileSearchCandidateScore(appCandidate, '"src/app.tsx"'), -1);
  assert.equal(getWorkspaceFileSearchCandidateScore(appCandidate, "src\\app.tsx"), -1);
  assert.equal(getWorkspaceFileSearchCandidateScore(appCandidate, "  src/app.tsx  "), -1);
  // 归一化本身是幂等的
  assert.equal(normalizeWorkspaceFileSearchQuery('"src\\app.tsx"'), "src/app.tsx");
});

test("归一化发生在过滤之前：带引号的查询仍能过滤出精确命中", () => {
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(WORKSPACE_FILES);
  const filtered = filterWorkspaceFileSearchCandidates(candidates, '"src/app.tsx"');
  assert.equal(filtered[0]?.relativePath, "src/app.tsx");
});

test("精确路径命中不被条数上限截断：排在末尾的精确命中仍排第一", () => {
  const many: WorkspaceFileEntry[] = [];
  for (let index = 0; index < 80; index += 1) {
    // 这些候选都能模糊命中同一查询，只有精确匹配的那条才排第一
    many.push(fileEntry({ name: `src/app-${index}.tsx` }));
  }
  // 精确目标放在候选末尾：top-K 只保留前 N 条时最容易把它挤掉
  many.push(fileEntry({ name: "src/app.tsx" }));
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(many);
  const filtered = filterWorkspaceFileSearchCandidates(candidates, "src/app.tsx", { limit: 50 });
  assert.equal(filtered.length, 50);
  assert.equal(filtered[0]?.relativePath, "src/app.tsx");
});

test("空查询时展示已打开文件：活动文件排最前，只取当前工作区", () => {
  const buffers: FilesBuffer[] = [
    {
      id: "a",
      kind: "text",
      untitled: false,
      path: "/w/src/app.tsx",
      title: "app.tsx",
      text: "",
      savedText: "",
      workspace: { workspacePath: "/w" },
    },
    {
      id: "b",
      kind: "text",
      untitled: false,
      path: "/w/README.md",
      title: "README.md",
      text: "",
      savedText: "",
      workspace: { workspacePath: "/w" },
    },
    {
      id: "c",
      kind: "text",
      untitled: false,
      path: "/other/src/app.tsx",
      title: "app.tsx",
      text: "",
      savedText: "",
      workspace: { workspacePath: "/other" },
    },
  ];

  const opened = buildSearchCenterOpenedFiles({
    buffers,
    openIds: ["a", "b", "c"],
    activeId: "b",
    workspacePath: "/w",
  });

  // 活动文件排最前
  assert.deepEqual(
    opened.map((file) => file.relativePath),
    ["README.md", "src/app.tsx"],
  );
  // 其它工作区的缓冲不混进来
  assert.equal(
    opened.some((file) => file.path.startsWith("/other/")),
    false,
  );
});

test("搜索中心与命令中心互斥：任一时刻最多打开一个", () => {
  let state = INITIAL_SEARCH_OVERLAY_STATE;

  state = openSearchCenter(state);
  assert.equal(state.searchCenterOpen, true);
  assert.equal(state.quickPickOpen, false);

  // 打开命令中心时搜索中心让位
  state = toggleQuickPick(state);
  assert.equal(state.quickPickOpen, true);
  assert.equal(state.searchCenterOpen, false);

  // 搜索中心重新打开时命令中心让位
  state = openSearchCenter(state);
  assert.equal(state.searchCenterOpen, true);
  assert.equal(state.quickPickOpen, false);

  // 浮层自身关闭不影响另一个浮层的业务状态
  state = setSearchCenterOpen(state, false);
  assert.equal(state.searchCenterOpen, false);
  state = setQuickPickOpen(state, true);
  assert.equal(state.quickPickOpen, true);
  assert.equal(state.searchCenterOpen, false);
});

test("搜索中心已打开时再按 ⌘P：只递增加焦请求号，不叠新实例", () => {
  let state = openSearchCenter(INITIAL_SEARCH_OVERLAY_STATE);
  const firstRequestId = state.searchCenterFocusRequestId;

  state = openSearchCenter(state);
  assert.equal(state.searchCenterOpen, true);
  assert.equal(state.searchCenterFocusRequestId, firstRequestId + 1);
});

test("结果必须属于当前查询才可回车：防抖窗口内与在途查询都不给旧结果", () => {
  const openedFiles = [
    { path: "/w/README.md", name: "README.md", relativePath: "README.md" },
  ];
  const entries = [
    { path: "/w/src/app.tsx", name: "app.tsx", relativePath: "src/app.tsx" },
  ];

  // 空查询：给已打开的文件
  assert.deepEqual(
    resolveSearchCenterRows({
      trimmedQuery: "",
      resultsQuery: "",
      entries,
      openedFiles,
    }),
    openedFiles,
  );

  // 结果对得上当前查询：给搜索结果
  assert.deepEqual(
    resolveSearchCenterRows({
      trimmedQuery: "app",
      resultsQuery: "app",
      entries,
      openedFiles,
    }),
    entries,
  );

  // 防抖窗口内：结果还属于上一个查询，不给可选项
  assert.deepEqual(
    resolveSearchCenterRows({
      trimmedQuery: "app",
      resultsQuery: "ap",
      entries,
      openedFiles,
    }),
    [],
  );

  // 新查询已发起、结果还在路上：同样不给可选项
  assert.deepEqual(
    resolveSearchCenterRows({
      trimmedQuery: "app",
      resultsQuery: "ap",
      entries: [],
      openedFiles,
    }),
    [],
  );
});

test("取消搜索中心不产生打开请求：只有确认选中才有目标文件", () => {
  const cancelled = resolveSearchCenterSelection(null);
  assert.equal(cancelled.confirmed, false);
  assert.equal(cancelled.entry, null);

  const confirmed = resolveSearchCenterSelection({
    path: "/w/src/app.tsx",
    name: "app.tsx",
    relativePath: "src/app.tsx",
  });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.entry?.path, "/w/src/app.tsx");
  assert.equal(confirmed.entry?.type, "file");
});

test("打开请求带聚焦意图：与打开请求在同一次写入里落地", () => {
  const store = createFilesEditorStore();
  assert.equal(store.getState().editorFocusRequestId, 0);
  assert.equal(store.getState().editorFocusRequest, undefined);

  store.getState().requestOpenPath({
    workspace: { workspacePath: "/w" },
    path: "/w/src/app.tsx",
    focus: true,
  });

  const afterOpen = store.getState();
  assert.equal(afterOpen.editorFocusRequestId, 1);
  assert.equal(afterOpen.editorFocusRequest?.path, "/w/src/app.tsx");
  assert.equal(afterOpen.editorFocusRequest?.requestId, 1);
  assert.equal(afterOpen.pendingOpen?.path, "/w/src/app.tsx");
});

test("没有聚焦要求的打开会清掉遗留的聚焦请求", () => {
  const store = createFilesEditorStore();
  store.getState().requestOpenPath({
    workspace: { workspacePath: "/w" },
    path: "/w/src/app.tsx",
    focus: true,
  });
  assert.ok(store.getState().editorFocusRequest);

  store.getState().requestOpenPath({
    workspace: { workspacePath: "/w" },
    path: "/w/README.md",
  });
  assert.equal(store.getState().editorFocusRequest, undefined);
  // 请求号不倒退，避免旧请求被误认为未消费
  assert.equal(store.getState().editorFocusRequestId, 1);
});

test("聚焦请求按 requestId 消费：过期的清除调用不误删新请求", () => {
  const store = createFilesEditorStore();
  store.getState().requestOpenPath({
    workspace: { workspacePath: "/w" },
    path: "/w/src/app.tsx",
    focus: true,
  });
  const requestId = store.getState().editorFocusRequestId;

  store.getState().clearEditorFocusRequest(requestId - 1);
  assert.ok(store.getState().editorFocusRequest, "过期 requestId 不应清掉当前请求");

  store.getState().clearEditorFocusRequest(requestId);
  assert.equal(store.getState().editorFocusRequest, undefined);
});

test("快速打开提供中英文设置页文案", () => {
  assert.equal(zhCN["settings.shortcuts.command.openQuickOpen"], "快速打开文件");
  assert.equal(enUS["settings.shortcuts.command.openQuickOpen"], "Quick Open (Go to File)");
});

test("搜索中心提供中英文文案", () => {
  assert.equal(zhCN["searchCenter.title"], "搜索中心");
  assert.equal(enUS["searchCenter.title"], "Search Center");
  for (const key of [
    "description",
    "placeholder",
    "hint",
    "noResults",
    "error",
    "retry",
    "waitingForConnection",
    "section.files",
    "section.opened",
  ]) {
    assert.ok(zhCN[`searchCenter.${key}`], `zh-CN 缺少 searchCenter.${key}`);
    assert.ok(enUS[`searchCenter.${key}`], `en-US 缺少 searchCenter.${key}`);
  }
});
