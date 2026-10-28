import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { WorkspaceFileTreeHeader } from "../src/workspace-file-tree/WorkspaceFileTreeHeader.js";
import { WorkspaceFileTreeSearchHeader } from "../src/workspace-file-tree/WorkspaceFileTreeSearchHeader.js";
import {
  WORKSPACE_FILE_SEARCH_FILTER_LIMIT,
  WORKSPACE_FILE_SEARCH_RESULT_LIMIT,
  clearWorkspaceFileTreeSearchFilters,
  clearWorkspaceFileTreeSearchForDirectoryReveal,
  countWorkspaceFileTreeSearchFilters,
  createWorkspaceFileTreeSearchState,
  getWorkspaceFileSearchIndexScopeKey,
  getWorkspaceFileTreeSearchFilterOptions,
  hasWorkspaceFileTreeSearchRange,
  isWorkspaceFileTreeSearchActive,
  limitWorkspaceFileTreeSearchResults,
  splitWorkspaceFileTreeSearchPatternInput,
  toggleWorkspaceFileTreeSearchFilterPanel,
  type WorkspaceFileTreeSearchState,
} from "../src/workspace-file-tree/workspaceFileTreeSearchModel.js";

function searchState(
  patch: Partial<WorkspaceFileTreeSearchState> = {},
): WorkspaceFileTreeSearchState {
  return { ...createWorkspaceFileTreeSearchState(), ...patch };
}

test("筛选入口按通配符项和开关计数，折叠保留条件并显示数量", () => {
  const expanded = searchState({
    include: " src/** , , **/*.ts ",
    exclude: "**/dist/**",
    includeIgnored: true,
    filtersExpanded: true,
  });
  assert.deepEqual(splitWorkspaceFileTreeSearchPatternInput(expanded.include), [
    "src/**",
    "**/*.ts",
  ]);
  assert.equal(countWorkspaceFileTreeSearchFilters(expanded), 4);

  const collapsed = toggleWorkspaceFileTreeSearchFilterPanel(expanded);
  assert.equal(collapsed.filtersExpanded, false);
  assert.equal(countWorkspaceFileTreeSearchFilters(collapsed), 4);
  assert.equal(collapsed.include, expanded.include);
  assert.equal(collapsed.exclude, expanded.exclude);
});

test("清除筛选保留关键词，仅重置范围条件和开关", () => {
  const state = searchState({
    query: "overlay",
    include: "**/*.ps1",
    exclude: "**/dist/**",
    includeIgnored: true,
    changedOnly: true,
    filtersExpanded: true,
  });
  const cleared = clearWorkspaceFileTreeSearchFilters(state);
  assert.equal(cleared.query, "overlay");
  assert.equal(cleared.include, "");
  assert.equal(cleared.exclude, "");
  assert.equal(cleared.includeIgnored, false);
  assert.equal(cleared.changedOnly, false);
  assert.equal(cleared.filtersExpanded, true);
  assert.equal(countWorkspaceFileTreeSearchFilters(cleared), 0);
});

test("无关键词但有范围条件进入平铺结果；仅看改动仍保持树形态", () => {
  assert.equal(isWorkspaceFileTreeSearchActive(searchState({ query: "   " })), false);
  assert.equal(isWorkspaceFileTreeSearchActive(searchState({ changedOnly: true })), false);
  assert.equal(isWorkspaceFileTreeSearchActive(searchState({ include: "**/*.ps1" })), true);
  assert.equal(isWorkspaceFileTreeSearchActive(searchState({ exclude: "**/dist/**" })), true);
  assert.equal(isWorkspaceFileTreeSearchActive(searchState({ includeIgnored: true })), true);
  assert.equal(hasWorkspaceFileTreeSearchRange(searchState({ includeIgnored: true })), true);
});

test("过滤选项为截断判断多取一条，并允许仅范围条件时空关键词", () => {
  assert.equal(WORKSPACE_FILE_SEARCH_RESULT_LIMIT, 1000);
  assert.equal(WORKSPACE_FILE_SEARCH_FILTER_LIMIT, 1001);

  const scopeOnly = getWorkspaceFileTreeSearchFilterOptions(searchState({ include: "**/*.ps1" }));
  assert.equal(scopeOnly.requireQuery, true);
  assert.equal(scopeOnly.limit, 1001);
  assert.equal(scopeOnly.include, "**/*.ps1");

  assert.equal(
    getWorkspaceFileTreeSearchFilterOptions(searchState({ includeIgnored: true })).requireQuery,
    false,
  );
  assert.equal(
    getWorkspaceFileTreeSearchFilterOptions(searchState({ query: "app" })).requireQuery,
    true,
  );
});

test("第 1001 项触发截断提示，1000 项内不提示", () => {
  const exactlyLimit = Array.from({ length: 1000 }, (_, index) => index);
  const overLimit = [...exactlyLimit, 1000];

  assert.deepEqual(limitWorkspaceFileTreeSearchResults(exactlyLimit), {
    items: exactlyLimit,
    hasMore: false,
  });
  const truncated = limitWorkspaceFileTreeSearchResults(overLimit);
  assert.equal(truncated.items.length, 1000);
  assert.equal(truncated.hasMore, true);
  assert.equal(truncated.items[999], 999);
});

test("索引隔离键随身份、路径、远程目标和忽略模式变化", () => {
  const base = {
    workspacePath: "/work",
    workspaceIdentity: "identity-a",
    workspaceRemoteSessionId: "remote-a",
    includeIgnored: false,
  };
  const baseKey = getWorkspaceFileSearchIndexScopeKey(base);
  assert.equal(getWorkspaceFileSearchIndexScopeKey({ ...base, includeIgnored: false }), baseKey);
  // 关键词、包含/排除不是索引键的一部分。
  assert.equal(getWorkspaceFileSearchIndexScopeKey(base), baseKey);
  assert.notEqual(getWorkspaceFileSearchIndexScopeKey({ ...base, includeIgnored: true }), baseKey);
  assert.notEqual(
    getWorkspaceFileSearchIndexScopeKey({ ...base, workspacePath: "/moved" }),
    baseKey,
  );
  assert.notEqual(
    getWorkspaceFileSearchIndexScopeKey({ ...base, workspaceIdentity: "identity-b" }),
    baseKey,
  );
  assert.notEqual(
    getWorkspaceFileSearchIndexScopeKey({ ...base, workspaceRemoteSessionId: "remote-b" }),
    baseKey,
  );
  // 无 identity 时回退到路径。
  assert.match(
    getWorkspaceFileSearchIndexScopeKey({ ...base, workspaceIdentity: "  " }),
    /^\/work/,
  );
});

test("工作区重置回到空状态；目录揭示清除关键词和范围条件", () => {
  assert.deepEqual(createWorkspaceFileTreeSearchState(), {
    query: "",
    include: "",
    exclude: "",
    filtersExpanded: false,
    includeIgnored: false,
    changedOnly: false,
  });

  const state = searchState({
    query: "src",
    include: "src/**",
    exclude: "**/dist/**",
    includeIgnored: true,
    changedOnly: true,
    filtersExpanded: true,
  });
  const revealed = clearWorkspaceFileTreeSearchForDirectoryReveal(state);
  assert.equal(isWorkspaceFileTreeSearchActive(revealed), false);
  assert.equal(revealed.filtersExpanded, true);
});

function renderWithLocale(locale: Locale, element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(ZCodeIntlProvider, { initialLocale: locale }, element));
}

test("合并 header 时不再渲染文件树自己的根标题，根操作只出现一次", () => {
  const rootActions = createElement("button", { type: "button" }, "root-actions");
  const custom = renderToStaticMarkup(
    createElement(WorkspaceFileTreeHeader, {
      title: "Workspace Alpha",
      rootActions,
      renderHeader: (actions: unknown) =>
        createElement(
          "div",
          { className: "custom-header" },
          createElement("span", null, "custom-title-owner"),
          actions,
        ),
    }),
  );
  assert.match(custom, /custom-title-owner/);
  assert.doesNotMatch(custom, /Workspace Alpha/);
  assert.equal(custom.match(/root-actions/g)?.length, 1);

  const fallback = renderToStaticMarkup(
    createElement(WorkspaceFileTreeHeader, {
      title: "Workspace Alpha",
      rootActions,
    }),
  );
  assert.equal(fallback.match(/Workspace Alpha/g)?.length, 1);
  assert.equal(fallback.match(/root-actions/g)?.length, 1);
});

test("搜索栏常驻；折叠时只显示生效数量，展开后显示包含/排除和开关", () => {
  const state = searchState({
    query: "overlay",
    include: "src/**, **/*.ts",
    exclude: "**/dist/**",
    includeIgnored: true,
  });
  const collapsed = renderWithLocale(
    "en-US",
    createElement(WorkspaceFileTreeSearchHeader, {
      state,
      gitStatusAvailable: true,
      onChange: () => undefined,
      onClearFilters: () => undefined,
    }),
  );
  assert.match(collapsed, /value="overlay"/);
  assert.match(collapsed, /text-mobile-input-safe/);
  assert.match(collapsed, /aria-label="Filters \(4 active\)"/);
  assert.match(collapsed, />Filters<\/span>/);
  assert.doesNotMatch(collapsed, /workspace-file-search-filters/);
  assert.doesNotMatch(collapsed, /Clear filters/);

  const expanded = renderWithLocale(
    "en-US",
    createElement(WorkspaceFileTreeSearchHeader, {
      state: { ...state, filtersExpanded: true },
      gitStatusAvailable: true,
      onChange: () => undefined,
      onClearFilters: () => undefined,
    }),
  );
  assert.match(expanded, /workspace-file-search-filters/);
  assert.match(expanded, /Include paths/);
  assert.match(expanded, /Exclude paths/);
  assert.match(expanded, /Search ignored files/);
  assert.match(expanded, /Changed only/);
  assert.match(expanded, /Clear filters/);
  assert.match(expanded, /value="src\/\*\*, \*\*\/\*\.ts"/);
});

test("筛选按钮为横向布局，14px 图标与数量徽章不会挤进方形按钮", () => {
  const markup = renderWithLocale(
    "en-US",
    createElement(WorkspaceFileTreeSearchHeader, {
      state: searchState({
        query: "overlay",
        include: "src/**, **/*.ts",
        exclude: "**/dist/**",
        includeIgnored: true,
      }),
      gitStatusAvailable: true,
      onChange: () => undefined,
      onClearFilters: () => undefined,
    }),
  );
  const trigger =
    markup.match(/<button[^>]*data-testid="workspace-file-search-filter-trigger"[^>]*>/)?.[0] ?? "";
  assert.ok(trigger, "filter trigger should render");
  assert.match(trigger, /data-size="sm"/);
  assert.match(trigger, /\bh-7\b/);
  assert.match(trigger, /\bpx-2\b/);
  assert.match(trigger, /\bgap-1\b/);
  // icon-sm / size-6 是 24px 方形，容不下 14px 图标 + 文案 + 徽章。
  assert.doesNotMatch(trigger, /\bsize-6\b|\bicon-sm\b|\bw-6\b/);
  assert.match(markup, /data-testid="workspace-file-search-filter-count"[^>]*>4</);
});

test("中文包含/排除示例使用解析器支持的 ASCII 逗号", () => {
  assert.equal(zhCN["workspaceFileTree.searchIncludePlaceholder"], "例如 **/*.ts, src/**");
  assert.equal(zhCN["workspaceFileTree.searchExcludePlaceholder"], "例如 **/dist/**, **/*.map");
  assert.doesNotMatch(zhCN["workspaceFileTree.searchIncludePlaceholder"] ?? "", /，/);
  assert.doesNotMatch(zhCN["workspaceFileTree.searchExcludePlaceholder"] ?? "", /，/);
});

test("Git 不可用时筛选面板不显示仅看改动", () => {
  const markup = renderWithLocale(
    "zh-CN",
    createElement(WorkspaceFileTreeSearchHeader, {
      state: searchState({ ...createWorkspaceFileTreeSearchState(), filtersExpanded: true }),
      gitStatusAvailable: false,
      onChange: () => undefined,
      onClearFilters: () => undefined,
    }),
  );
  assert.match(markup, /包含路径/);
  assert.doesNotMatch(markup, /仅看改动/);
});

test("新增搜索与筛选文案在中英文都完整", () => {
  const ids = [
    "workspaceFileTree.searchPlaceholder",
    "workspaceFileTree.searchLabel",
    "workspaceFileTree.searchFilters",
    "workspaceFileTree.searchFiltersActive",
    "workspaceFileTree.searchInclude",
    "workspaceFileTree.searchIncludePlaceholder",
    "workspaceFileTree.searchExclude",
    "workspaceFileTree.searchExcludePlaceholder",
    "workspaceFileTree.searchPatternHint",
    "workspaceFileTree.searchIncludeIgnored",
    "workspaceFileTree.searchChangedOnly",
    "workspaceFileTree.searchClearFilters",
    "workspaceFileTree.searchResultsTruncated",
    "workspaceFileTree.filtering",
    "filesWorkbench.newUntitledFile",
  ];
  for (const id of ids) {
    assert.ok(enUS[id], `missing en-US: ${id}`);
    assert.ok(zhCN[id], `missing zh-CN: ${id}`);
  }
});

test("文件主视图只提供一处工作区名、新建入口与根操作，不复制树自己的根菜单控制器", () => {
  const paneSource = readFileSync(
    new URL("../src/files-workbench/FilesExplorerPane.tsx", import.meta.url),
    "utf8",
  );
  const treeSource = readFileSync(
    new URL("../src/workspace-file-tree/WorkspaceFileTree.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(paneSource.match(/data-testid=\{TID_FILES_EXPLORER_WORKSPACE\}/g)?.length, 1);
  assert.equal(paneSource.match(/data-testid=\{TID_FILES_NEW_FILE\}/g)?.length, 1);
  assert.equal(paneSource.match(/renderHeader=\{/g)?.length, 1);
  assert.equal(paneSource.match(/\{rootActions\}/g)?.length, 1);
  assert.match(paneSource, /filesWorkbench\.newUntitledFile/);
  assert.doesNotMatch(paneSource, /filesWorkbench\.newFile/);
  // 根菜单与动作控制器归文件树所有，主视图不能复制一份。
  assert.doesNotMatch(paneSource, /WorkspaceFileRootMenu|useWorkspaceFileActions/);

  assert.equal(treeSource.match(/<WorkspaceFileTreeHeader\b/g)?.length, 1);
  assert.equal(treeSource.match(/renderHeader=\{renderHeader\}/g)?.length, 1);
  assert.equal(treeSource.match(/const rootActions = \(/g)?.length, 1);
});
