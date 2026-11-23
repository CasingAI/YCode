import assert from "node:assert/strict";
import test from "node:test";
import { filterVisibleWorkspaceMenuTabs } from "../src/ChatEmptyState.js";
import { buildPersistedWorkspaceSessionEntries } from "../src/lib/remoteWorkspaceHistory.js";
import { restorePersistedRemoteWorkspaceSessions } from "../src/root/remoteWorkspaceSessionPersistence.js";
import { createTabStore } from "../src/store/tabStore.js";
import type { AppSettings } from "@zcode/shared";

/**
 * workspace 切换菜单的搜索与最近使用排序。
 * 搜索此前把完整路径拼进匹配文本，`C:\Users\...` 让单个常见字母命中全部项目；
 * 排序此前沿用侧栏手动顺序。激活时间由 tab store 独占写入，并随会话快照持久化。
 */

const gitHub = (name: string) => `C:\\Users\\MPC\\Documents\\GitHub\\${name}`;
const tab = (name: string, lastActivatedAt?: number) => ({
  workspacePath: gitHub(name),
  label: name,
  lastActivatedAt,
});
const names = (tabs: ReadonlyArray<{ workspacePath: string }>) =>
  tabs.map((item) => item.workspacePath.split("\\").pop());

test("搜索：单个字母只匹配名称，不再被路径里的 Users、GitHub 命中", () => {
  const visible = filterVisibleWorkspaceMenuTabs({
    workspaceTabs: [
      tab("MusicFree"),
      tab("MusicFreePlugins"),
      tab("2026-11"),
      tab("pog"),
      tab("AICast"),
      tab("YCode"),
    ],
    homeWorkspaceLabel: "主目录",
    searchQuery: "r",
  });

  assert.deepEqual(names(visible), ["MusicFree", "MusicFreePlugins"]);
});

test("搜索：大小写不敏感，多字母按名称匹配", () => {
  const workspaceTabs = [tab("MusicFree"), tab("MusicFreePlugins"), tab("pog")];
  const search = (searchQuery: string) =>
    names(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs,
        homeWorkspaceLabel: "主目录",
        searchQuery,
      }),
    );

  assert.deepEqual(search(" MUSIC "), ["MusicFree", "MusicFreePlugins"]);
  assert.deepEqual(search("pog"), ["pog"]);
  assert.deepEqual(search("zzz"), []);
});

test("搜索：查询词带分隔符或盘符时才按路径匹配", () => {
  const workspaceTabs = [tab("MusicFree"), tab("AICast")];
  const search = (searchQuery: string) =>
    names(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs,
        homeWorkspaceLabel: "主目录",
        searchQuery,
      }),
    );

  // “users” 只出现在路径里，不带分隔符时不命中。
  assert.deepEqual(search("users"), []);
  assert.deepEqual(search("\\users\\mpc\\documents"), ["MusicFree", "AICast"]);
  assert.deepEqual(search("github/music"), ["MusicFree"]);
  assert.deepEqual(search("github\\music"), ["MusicFree"]);
  assert.deepEqual(search("c:"), ["MusicFree", "AICast"]);
  assert.deepEqual(search("musicfree"), ["MusicFree"]);
});

test("搜索：远程 workspace 的目标描述只在路径查询时参与匹配", () => {
  const remoteTab = {
    ...tab("deploy"),
    remoteSessionId: "rs-1",
    workspaceIdentity: "ssh://dev@10.0.0.1/home/dev/deploy",
    remoteTarget: {
      kind: "ssh" as const,
      username: "dev",
      host: "10.0.0.1",
      port: 22,
      authMethod: "key" as const,
    },
  };
  const search = (searchQuery: string) =>
    names(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: [remoteTab, tab("pog")],
        homeWorkspaceLabel: "主目录",
        searchQuery,
      }),
    );

  assert.deepEqual(search("ssh"), []);
  // 远程路径与目标描述只在路径查询时参与匹配，分隔符两侧统一。
  assert.deepEqual(search("/home/dev"), ["deploy"]);
  assert.deepEqual(search("ssh://dev"), ["deploy"]);
});

test("排序：按最近激活时间降序，再截取前 5 条", () => {
  const visible = filterVisibleWorkspaceMenuTabs({
    workspaceTabs: [
      tab("a", 10),
      tab("b", 50),
      tab("c", 30),
      tab("d", 40),
      tab("e", 20),
      tab("f", 60),
      tab("g", 5),
    ],
    homeWorkspaceLabel: "主目录",
    searchQuery: "",
  });

  assert.deepEqual(names(visible), ["f", "b", "d", "c", "e"]);
});

test("排序：没有激活时间的排在最后，其余保持传入顺序", () => {
  const visible = filterVisibleWorkspaceMenuTabs({
    workspaceTabs: [tab("a"), tab("b"), tab("c", 1), tab("d"), tab("e", 2)],
    homeWorkspaceLabel: "主目录",
    searchQuery: "",
  });

  assert.deepEqual(names(visible), ["e", "c", "a", "b", "d"]);
});

const lastActivatedAtOf = (store: ReturnType<typeof createTabStore>, workspacePath: string) =>
  store
    .getState()
    .tabs.find((item) => item.kind === "workspace" && item.workspacePath === workspacePath)
    ?.kind === "workspace"
    ? (
        store.getState().tabs.find(
          (item) => item.kind === "workspace" && item.workspacePath === workspacePath,
        ) as { lastActivatedAt?: number }
      ).lastActivatedAt
    : undefined;

test("tab store：新建与切换 workspace 时写入严格递增的激活时间", () => {
  const store = createTabStore();
  store.getState().addTab(gitHub("a"));
  store.getState().addTab(gitHub("b"));
  const aAt = lastActivatedAtOf(store, gitHub("a"));
  const bAt = lastActivatedAtOf(store, gitHub("b"));
  assert.ok(typeof aAt === "number" && typeof bAt === "number" && aAt < bAt);

  const aId = store.getState().tabs.find((item) => item.kind === "workspace" && item.label === "a")
    ?.id as string;
  store.getState().activateTab(aId);
  assert.ok((lastActivatedAtOf(store, gitHub("a")) as number) > bAt);

  // 重复激活当前 tab 不更新时间。
  const aAtAgain = lastActivatedAtOf(store, gitHub("a"));
  store.getState().activateTab(aId);
  assert.equal(lastActivatedAtOf(store, gitHub("a")), aAtAgain);

  store.getState().activateTabByPath(gitHub("b"));
  assert.ok((lastActivatedAtOf(store, gitHub("b")) as number) > (aAtAgain as number));
  const bAtAgain = lastActivatedAtOf(store, gitHub("b"));
  store.getState().activateTabByPath(gitHub("b"));
  assert.equal(lastActivatedAtOf(store, gitHub("b")), bAtAgain);
});

test("tab store：ensureWorkspaceTab 不写激活时间，打开设置页不改激活时间", () => {
  const store = createTabStore();
  store.getState().addTab(gitHub("a"));
  const aAt = lastActivatedAtOf(store, gitHub("a"));

  store.getState().ensureWorkspaceTab(gitHub("b"));
  assert.equal(lastActivatedAtOf(store, gitHub("b")), undefined);

  store.getState().openSettingsTab();
  assert.equal(lastActivatedAtOf(store, gitHub("a")), aAt);
});

test("tab store：关闭当前 workspace 后，接替者成为最近激活", () => {
  const store = createTabStore();
  store.getState().addTab(gitHub("a"));
  store.getState().addTab(gitHub("b"));
  const aAt = lastActivatedAtOf(store, gitHub("a"));
  const bId = store.getState().activeTabId as string;

  store.getState().closeTab(bId);

  assert.ok((lastActivatedAtOf(store, gitHub("a")) as number) > (aAt as number));
});

test("持久化与恢复：激活时间随会话快照往返，菜单顺序不变", () => {
  const store = createTabStore();
  store.getState().addTab(gitHub("a"));
  store.getState().addTab(gitHub("b"));
  store.getState().addTab(gitHub("c"));
  store.getState().activateTabByPath(gitHub("a"));

  const entries = buildPersistedWorkspaceSessionEntries(store.getState().tabs, new Map());
  assert.deepEqual(
    entries.map((entry) => [entry.workspacePath, entry.lastActivatedAt]),
    [
      [gitHub("c"), lastActivatedAtOf(store, gitHub("c"))],
      [gitHub("b"), lastActivatedAtOf(store, gitHub("b"))],
      [gitHub("a"), lastActivatedAtOf(store, gitHub("a"))],
    ],
  );

  const restored = createTabStore();
  restorePersistedRemoteWorkspaceSessions({
    settings: { lastWorkspaceSession: entries, lastActiveTabIndex: 2 } as AppSettings,
    tabStoreApi: restored,
  });

  // 被恢复为激活项的 a 以本次恢复时间为准，仍是最新的；b、c 保留原时间且顺序不变。
  const restoredTabs = restored
    .getState()
    .tabs.filter((item) => item.kind === "workspace")
    .map((item) =>
      item.kind === "workspace"
        ? { workspacePath: item.workspacePath, label: item.label, lastActivatedAt: item.lastActivatedAt }
        : null,
    )
    .filter((item) => item !== null);
  assert.deepEqual(
    names(
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: restoredTabs,
        homeWorkspaceLabel: "主目录",
        searchQuery: "",
      }),
    ),
    ["a", "c", "b"],
  );
});

test("持久化：从未激活的 workspace 不写出 lastActivatedAt 字段", () => {
  const store = createTabStore();
  store.getState().addTab(gitHub("a"));
  store.getState().ensureWorkspaceTab(gitHub("b"));

  const entries = buildPersistedWorkspaceSessionEntries(store.getState().tabs, new Map());
  const entryForB = entries.find((item) => item.workspacePath === gitHub("b"));
  assert.ok(entryForB);
  assert.equal("lastActivatedAt" in entryForB, false);
});
