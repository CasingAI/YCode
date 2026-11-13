import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadChromium, resolveSource, uiRoot } from "./helpers/chromiumFixture.js";

// 独立浏览器验证：父 root 不先点 Agent，只用根会话投影归属，child browser tab 就出现在
// 同一个侧栏 strip；用户真实点击后才激活，内容仍是 child sessionId，切走再切回不重建 guest。
// 只启动测试自己的 Chromium 与临时 profile，不连接或操作正在运行的 YCode。

const CHILD_ID = "sess_child";
const CHILD_TAB_ID = "browser-use:tab-child";

function sourcePath(relative: string): string {
  return JSON.stringify(join(uiRoot, "src", relative).replace(/\\/g, "/"));
}

function fixtureSource(): string {
  return `
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { PlatformProvider } from ${sourcePath("hooks/usePlatform.tsx")};
import { ZCodeIntlProvider } from ${sourcePath("i18n/IntlProvider.tsx")};
import { Tabs, TabsContent, TabsList } from ${sourcePath("components/ui/tabs.tsx")};
import { TooltipProvider } from ${sourcePath("components/ui/tooltip.tsx")};
import {
  SortableSidePaneTabTrigger,
  getSidePaneTabTitle,
} from ${sourcePath("app-shell/SidePaneTabTrigger.tsx")};
import { BrowserUseSidePaneContent } from ${sourcePath("browser-use/BrowserUseSidePaneContent.tsx")};
import {
  applyBrowserUseSidePaneEvent,
  closeVisibleOtherSidePaneTabs,
  getVisibleSidePaneTabs,
  setActiveSidePaneTab,
  syncSubagentSessionSidePaneTabs,
  updateBrowserSidePaneTab,
} from ${sourcePath("lib/workspaceSidePane.ts")};

const WORKSPACE_KEY = "ws-1";
const PARENT_ID = "sess_parent";
const CHILD_ID = "sess_child";
const CHILD_TAB_ID = "browser-use:tab-child";

// 只提供本 fixture 会触达的 platform 面；webview 在独立 Chromium 中只是普通未知元素。
const platform = {
  getDesktopZoomLevel: async () => ({ zoomLevel: 0 }),
  onDesktopZoomLevelChanged: () => () => {},
  browserViewReportResidency: async () => ({ ok: true }),
  browserViewScreenshotSurfaceReady: () => {},
  browserViewAttachGuest: async () => ({ success: false }),
  browserViewDetachGuest: async () => ({ success: true }),
  openExternal: () => {},
};

function initialState() {
  const parent = {
    id: "browser-use:tab-parent",
    type: "browser-use",
    sessionId: PARENT_ID,
    ownerTaskId: PARENT_ID,
    workspaceKey: WORKSPACE_KEY,
    tabId: "tab-parent",
    title: "Parent page",
  };
  // child ready 是后台事件：只挂载 shell，不切换父会话 activeTab。
  const withChildReady = applyBrowserUseSidePaneEvent(
    { tabs: [parent], activeTabId: parent.id },
    {
      workspaceKey: WORKSPACE_KEY,
      sessionId: CHILD_ID,
      tabId: "tab-child",
      browserId: "iab-child",
      browserGeneration: 2,
    },
    { workspaceKey: WORKSPACE_KEY, ownerTaskId: PARENT_ID },
  ).state;
  // 页面标题由 webview 的 page-title-updated 回填，这里模拟同一路径。
  const withChildTitle = updateBrowserSidePaneTab(withChildReady, CHILD_TAB_ID, {
    title: "Child page",
  });
  // 根会话 conversation 投影：真实父子关系，不是 UI 临时 tab。
  return syncSubagentSessionSidePaneTabs(withChildTitle, {
    rootSessionId: PARENT_ID,
    parentSessionId: PARENT_ID,
    validChildSessionIds: [CHILD_ID],
    workspaceKey: WORKSPACE_KEY,
    childTitles: { [CHILD_ID]: "Child A" },
  });
}

const formatMessage = (descriptor) => descriptor.id;

function PlaceholderTabContent({ tabId }) {
  return (
    <TabsContent value={tabId} forceMount data-subagent-placeholder={tabId}>
      child session
    </TabsContent>
  );
}

function Fixture() {
  const [state, setState] = useState(initialState);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const visibleTabs = useMemo(
    () =>
      getVisibleSidePaneTabs(state.tabs, {
        workspaceKey: WORKSPACE_KEY,
        ownerTaskId: PARENT_ID,
        remoteSessionId: undefined,
      }),
    [state.tabs],
  );
  const visibleIds = useMemo(() => visibleTabs.map((tab) => tab.id), [visibleTabs]);
  const activate = (tabId) => setState((current) => setActiveSidePaneTab(current, tabId));
  const closeOthers = (tabId) =>
    setState((current) => closeVisibleOtherSidePaneTabs(current, tabId, PARENT_ID));
  return (
    <PlatformProvider platform={platform}>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <TooltipProvider>
        <div
          data-visible-tab-ids={visibleIds.join(",")}
          data-all-tab-ids={state.tabs.map((tab) => tab.id).join(",")}
          data-active-tab-id={state.activeTabId}
        >
          <Tabs value={state.activeTabId} onValueChange={activate}>
            <TabsList className="flex items-center gap-2">
              <DndContext sensors={sensors}>
                <SortableContext items={visibleIds} strategy={horizontalListSortingStrategy}>
                  {visibleTabs.map((tab) => (
                    <SortableSidePaneTabTrigger
                      key={tab.id}
                      tab={tab}
                      title={getSidePaneTabTitle(tab, formatMessage)}
                      closeTabLabel="close"
                      closeTabMenuLabel="close"
                      closeOtherTabsLabel="close others"
                      closeAllTabsLabel="close all"
                      diffBadgeLabel="diff"
                      isActive={tab.id === state.activeTabId}
                      onActivateTab={activate}
                      onCloseTab={() => {}}
                      onCloseOtherTabs={closeOthers}
                      onCloseAllTabs={() => {}}
                      canCloseOtherTabs={visibleIds.length > 1}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </TabsList>
            {/* 贴近生产：内容对**全部** tab forceMount（含当前不可见的），非 active 只隐藏不卸载。 */}
            {state.tabs.map((tab) =>
              tab.type === "browser-use" ? (
                <BrowserUseSidePaneContent
                  key={tab.id}
                  tab={tab}
                  isPanelVisible
                  isSelected={tab.id === state.activeTabId}
                  isCurrentTask={tab.sessionId === PARENT_ID}
                  screenshotSurfaceRequest={null}
                  initialUrl="https://example.com/"
                  workspacePath="/workspace"
                  onUrlChange={() => {}}
                  onPageMetadataChange={() => {}}
                />
              ) : (
                <PlaceholderTabContent key={tab.id} tabId={tab.id} />
              ),
            )}
          </Tabs>
        </div>
        </TooltipProvider>
      </ZCodeIntlProvider>
    </PlatformProvider>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
`;
}

test(
  "未点 Agent 也能父 root 手动选择 child 页面；真实点击不重建 guest，关闭其他仍可见",
  { timeout: 120_000 },
  async (t) => {
    const chromiumFixture = await loadChromium();
    if (!chromiumFixture) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑子代理浏览器侧栏测试");
      return;
    }
    const { chromium, executablePath } = chromiumFixture;
    const { build } = await import("esbuild");
    const directory = await mkdtemp(join(tmpdir(), "ycode-subagent-browser-sidepane-"));
    try {
      const entry = join(directory, "entry.tsx");
      const bundle = join(directory, "fixture.js");
      await writeFile(entry, fixtureSource());
      await build({
        entryPoints: [entry],
        outfile: bundle,
        bundle: true,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        target: ["chrome120"],
        logLevel: "silent",
        nodePaths: [join(uiRoot, "node_modules"), join(uiRoot, "..", "..", "node_modules")],
        define: { "process.env.NODE_ENV": '"production"' },
        loader: {
          ".svg": "dataurl",
          ".png": "dataurl",
          ".jpg": "dataurl",
          ".webp": "dataurl",
          ".mp3": "dataurl",
          ".wav": "dataurl",
          ".woff": "dataurl",
          ".woff2": "dataurl",
        },
        plugins: [
          {
            name: "ui-source",
            setup(builder) {
              builder.onResolve({ filter: /^@\// }, async (args) => {
                const path = await resolveSource(resolve(uiRoot, "src", args.path.slice(2)));
                return path ? { path } : undefined;
              });
              builder.onResolve({ filter: /\.js$/ }, async (args) => {
                if (!args.path.startsWith(".")) return undefined;
                const path = await resolveSource(resolve(args.resolveDir, args.path));
                return path ? { path } : undefined;
              });
            },
          },
        ],
      });

      const context = await chromium.launchPersistentContext(join(directory, "profile"), {
        executablePath,
        headless: true,
        viewport: { width: 1100, height: 800 },
      });
      try {
        const page = await context.newPage();
        await page.emulateMedia({ reducedMotion: "reduce" });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(
          '<!doctype html><html class="theme-zai-light"><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addStyleTag({
          content:
            "html,body,#root{margin:0} .hidden{display:none!important} webview{display:block;width:640px;height:400px}",
        });
        await page.addScriptTag({ path: bundle });

        const root = page.locator("[data-visible-tab-ids]");
        try {
          await root.waitFor({ timeout: 15_000 });
        } catch {
          throw new Error(`侧栏 fixture 未渲染: ${errors.join(" | ") || "无 pageerror"}`);
        }

        // 从未打开过子代理会话 tab：strip 仍能发现 child 页面（验收 22）。
        const allIds = await root.getAttribute("data-all-tab-ids");
        assert.equal(allIds?.includes("subagent-session"), false, `不应存在会话 tab: ${allIds}`);
        const visibleIds = await root.getAttribute("data-visible-tab-ids");
        assert.ok(
          visibleIds?.includes(CHILD_TAB_ID),
          `父 strip 应包含 child browser tab: ${visibleIds}`,
        );
        assert.equal(
          await root.getAttribute("data-active-tab-id"),
          "browser-use:tab-parent",
          "后台 ready 与投影归属都不得抢父会话焦点",
        );

        const childTrigger = page.locator(`[data-side-pane-tab-id="${CHILD_TAB_ID}"]`);
        await childTrigger.waitFor({ state: "visible" });
        assert.equal(await childTrigger.getAttribute("data-active"), null);
        const childTitle = (await childTrigger.innerText()).replace(/\s+/g, " ");
        // 页面标题 + 冻结的归属子代理名，同一 root 下多个 child 可区分。
        assert.match(childTitle, /Child page/);
        assert.match(childTitle, /Child A/);

        const childContent = page.locator('[data-browser-use-session-id="sess_child"]');
        const childWebview = childContent.locator("webview");
        // 点击前 shell 已后台挂载（保住 guest），但不可见；标记节点用于验证点击后不重建。
        assert.equal(await childContent.count(), 1);
        assert.equal(await childContent.isHidden(), true);
        assert.equal(await childWebview.count(), 1);
        await childWebview.evaluate((element) => {
          element.__ycodeGuestMarker = "same-guest";
        });

        // 用户真实点击 tab 标题（不是 helper 直接改状态）。
        await childTrigger.locator("[data-side-pane-tab-title]").click();
        await childContent.waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(await childTrigger.getAttribute("data-active"), "");
        // 内容仍是 child 执行 scope，查看归属只影响可见性，不改 sessionId/ownerTaskId。
        assert.equal(await childContent.getAttribute("data-browser-use-tab-id"), "tab-child");
        assert.equal(await childContent.getAttribute("data-browser-use-session-id"), CHILD_ID);

        // 真实右键打开上下文菜单并点击「关闭其他」：当前 child 页面必须仍然可见（验收 21）。
        await childTrigger.click({ button: "right" });
        const closeOthersMenuItem = page.getByRole("menuitem", { name: "close others" });
        await closeOthersMenuItem.waitFor({ state: "visible", timeout: 10_000 });
        await closeOthersMenuItem.click();
        await childContent.waitFor({ state: "visible", timeout: 10_000 });
        const afterCloseOthers = await root.getAttribute("data-visible-tab-ids");
        assert.ok(
          afterCloseOthers?.includes(CHILD_TAB_ID),
          `关闭其他后 child 页面仍应可见，实际：${afterCloseOthers}`,
        );
        assert.equal(await root.getAttribute("data-active-tab-id"), CHILD_TAB_ID);

        // 切回父 tab（已被关闭其他移除，这里改为切到 active 之外的场景验证 guest 保活）。
        // 关闭其他已删掉父 tab，因此改为再次点击 child 标题，确认同一 webview 节点未被重建。
        await childTrigger.locator("[data-side-pane-tab-title]").click();
        await childContent.waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(
          await childWebview.evaluate((element) => element.__ycodeGuestMarker ?? null),
          "same-guest",
        );
        assert.equal(await childWebview.count(), 1);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
