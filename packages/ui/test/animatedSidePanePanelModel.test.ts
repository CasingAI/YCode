import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAnimatedSidePanePanelLayout,
  resolveOpenTabLauncherItemIds,
  shouldOfferPlanDirectory,
  shouldOfferSubagentDirectory,
  shouldWrapAnimatedSidePanePanel,
} from "../src/app-shell/animatedSidePanePanelModel.js";

// 分栏形态下面板只占分栏组的一段宽度：下限 240px 保证内容可读，上限 65% 保证会话列还在。
test("分栏形态：面板在 240px 与 65% 之间", () => {
  const layout = resolveAnimatedSidePanePanelLayout({ presentation: "inline" });
  assert.equal(layout.minSize, "240px");
  assert.equal(layout.maxSize, "65%");
  assert.equal(layout.defaultSize, "0px");
  assert.equal(layout.collapsedSize, "0px");
});

// 覆盖层形态下面板自己就是最终宽度：240px 下限会让它在窄屏收不起，
// 65% 上限又会让它永远填不满包裹层。
test("覆盖层形态：面板宽度不受分栏上下限限制", () => {
  const layout = resolveAnimatedSidePanePanelLayout({ presentation: "drawer" });
  assert.equal(layout.minSize, "0px");
  assert.equal(layout.maxSize, "100%");
  assert.equal(layout.defaultSize, "0px");
  assert.equal(layout.collapsedSize, "0px");
});

// 两种形态都必须继续渲染 ResizablePanel：换成普通容器会改变元素类型，
// 面板重挂载后远端 Browser Guest 会被销毁。
test("两种形态都保留 ResizablePanel", () => {
  assert.equal(
    resolveAnimatedSidePanePanelLayout({ presentation: "inline" }).useResizablePanel,
    true,
  );
  assert.equal(
    resolveAnimatedSidePanePanelLayout({ presentation: "drawer" }).useResizablePanel,
    true,
  );
  // 不传形态时退回分栏语义，避免调用点漏传时面板在宽屏失去宽度下限。
  assert.deepEqual(resolveAnimatedSidePanePanelLayout(), resolveAnimatedSidePanePanelLayout({}));
  assert.equal(resolveAnimatedSidePanePanelLayout().minSize, "240px");
});

test("启动器：活动会话展示计划目录入口", () => {
  const itemIds = resolveOpenTabLauncherItemIds({
    canOpenPlanDirectory: true,
    developerToolsEnabled: false,
    hasReviewTab: false,
    supportsEmbeddedBrowser: true,
  });
  assert.deepEqual(itemIds, ["review", "plan-directory", "terminal", "browser"]);
});

test("启动器：活动会话展示子智能体目录入口（计划目录之后、终端之前）", () => {
  const itemIds = resolveOpenTabLauncherItemIds({
    canOpenPlanDirectory: true,
    canOpenSubagentDirectory: true,
    developerToolsEnabled: false,
    hasReviewTab: false,
    supportsEmbeddedBrowser: true,
  });
  assert.deepEqual(itemIds, [
    "review",
    "plan-directory",
    "subagent-directory",
    "terminal",
    "browser",
  ]);
});

test("启动器：子智能体目录入口不依赖计划目录门控", () => {
  const itemIds = resolveOpenTabLauncherItemIds({
    canOpenPlanDirectory: false,
    canOpenSubagentDirectory: true,
    developerToolsEnabled: false,
    hasReviewTab: true,
    supportsEmbeddedBrowser: false,
  });
  assert.deepEqual(itemIds, ["subagent-directory", "terminal"]);
});

test("启动器：草稿态不展示计划目录入口", () => {
  const itemIds = resolveOpenTabLauncherItemIds({
    canOpenPlanDirectory: false,
    developerToolsEnabled: false,
    hasReviewTab: true,
    supportsEmbeddedBrowser: false,
  });
  assert.deepEqual(itemIds, ["terminal"]);
});

test("启动器：计划入口不依赖是否已有审查 tab", () => {
  const itemIds = resolveOpenTabLauncherItemIds({
    canOpenPlanDirectory: true,
    developerToolsEnabled: true,
    hasReviewTab: true,
    supportsEmbeddedBrowser: false,
  });
  assert.equal(itemIds.includes("plan-directory"), true);
  assert.equal(itemIds.includes("review"), false);
  assert.equal(itemIds.includes("terminal"), true);
  assert.equal(itemIds.includes("developer-tools"), true);
});

test("启动器：计划入口只在有活动会话时提供", () => {
  assert.equal(shouldOfferPlanDirectory({ activeTaskId: "sess_1" }), true);
  assert.equal(shouldOfferPlanDirectory({ activeTaskId: null }), false);
});

test("启动器：子智能体目录入口只在有活动会话时提供（与计划目录同口径）", () => {
  assert.equal(shouldOfferSubagentDirectory({ activeTaskId: "sess_1" }), true);
  assert.equal(shouldOfferSubagentDirectory({ activeTaskId: null }), false);
});

// 宽屏下手柄与面板直挂分栏组：库的拖拽命中区只枚举 Group 根元素的直接子节点，
// 中间隔一层 display:contents 的 div 也算不出命中区，右边栏会拖不动。
// 窄屏覆盖层本来就没有手柄，才允许包裹层存在。
test("分栏形态不包覆盖层，覆盖层形态才包", () => {
  assert.equal(shouldWrapAnimatedSidePanePanel({ presentation: "inline" }), false);
  assert.equal(shouldWrapAnimatedSidePanePanel({ presentation: "drawer" }), true);
  // 不传形态时退回分栏语义，与 resolveAnimatedSidePanePanelLayout 的缺省一致。
  assert.equal(shouldWrapAnimatedSidePanePanel(), false);
  assert.equal(shouldWrapAnimatedSidePanePanel({}), false);
});
