import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkspaceContentIsolationClassName,
  resolveWorkspaceContentMinWidthClassName,
  resolveWorkspaceSidePaneExpandedSize,
  resolveWorkspaceSidePanePanelSurfaceClassName,
  resolveWorkspaceSidePaneWrapperClassName,
  resolveWorkspaceSidebarPanelPositionClassName,
  resolveWorkspaceSidebarPanelSurfaceClassName,
  resolveWorkspaceSidebarPanelWidthCssValue,
  resolveWorkspaceSidebarPresentation,
  shouldCollapseWorkspaceSidebarAfterNavigation,
  shouldRenderWorkspaceSidePaneBackdrop,
  shouldRenderWorkspaceSidePaneResizeHandle,
  shouldRenderWorkspaceSidebarBackdrop,
  shouldRenderWorkspaceSidebarResizeHandle,
  WORKSPACE_OVERLAY_PANEL_SURFACE_CLASS,
  WORKSPACE_SIDE_PANE_BACKDROP_Z_CLASS,
} from "../src/app-shell/workspaceShellResponsiveLayout.js";
import {
  NARROW_VIEWPORT_MAX_WIDTH_PX,
  NARROW_VIEWPORT_MEDIA_QUERY,
} from "../src/lib/narrowViewport.js";

// 断点必须和仓库既有的 max-md 对齐，否则外壳会出现第二套窄屏口径。
test("窄视口断点与 max-md 对齐", () => {
  assert.equal(NARROW_VIEWPORT_MAX_WIDTH_PX, 768);
  assert.equal(NARROW_VIEWPORT_MEDIA_QUERY, "(max-width: 767.98px)");
});

test("窄视口取抽屉形态，宽视口取内联列", () => {
  assert.equal(resolveWorkspaceSidebarPresentation({ isNarrowViewport: true }), "drawer");
  assert.equal(resolveWorkspaceSidebarPresentation({ isNarrowViewport: false }), "inline");
});

// 抽屉宽度只跟视口比例有关：展开/收起不能改变宽度，否则动画会变成宽度挤压。
test("抽屉宽度不随侧栏显隐变化", () => {
  const base = { presentation: "drawer" as const, inlineWidthPx: 264, collapsedInlineWidthPx: 0 };
  const open = resolveWorkspaceSidebarPanelWidthCssValue({ ...base, isSidebarVisible: true });
  const closed = resolveWorkspaceSidebarPanelWidthCssValue({ ...base, isSidebarVisible: false });
  assert.equal(open, "min(85vw, 320px)");
  assert.equal(closed, open);
});

test("内联列宽度沿用原语义：展开用面板宽度、收起用收起宽度", () => {
  const base = { presentation: "inline" as const, inlineWidthPx: 264, collapsedInlineWidthPx: 4 };
  assert.equal(
    resolveWorkspaceSidebarPanelWidthCssValue({ ...base, isSidebarVisible: true }),
    "264px",
  );
  assert.equal(
    resolveWorkspaceSidebarPanelWidthCssValue({ ...base, isSidebarVisible: false }),
    "4px",
  );
});

// 内容区 320px 下限在抽屉模式下会把内容顶出视口，是手机上右侧被裁切的直接原因。
test("内容区最小宽度：内联列保留 320px，抽屉改为 min-w-0", () => {
  assert.equal(
    resolveWorkspaceContentMinWidthClassName({ presentation: "inline" }),
    "min-w-[320px]",
  );
  assert.equal(resolveWorkspaceContentMinWidthClassName({ presentation: "drawer" }), "min-w-0");
});

// 会话列内部的 z-10/z-20 在窄屏会逃逸到根层叠上下文，必须由内容区自己关住，
// 否则遮罩点不到、抽屉会被建议行压过。
test("内容区层级隔离：抽屉模式下建立独立层叠上下文", () => {
  assert.equal(resolveWorkspaceContentIsolationClassName({ presentation: "inline" }), "");
  assert.equal(resolveWorkspaceContentIsolationClassName({ presentation: "drawer" }), "isolate");
});

// 抽屉浮在会话之上，没有不透明表面就会透出下层文字。
test("侧栏表面：内联列不带底色，抽屉自带不透明表面", () => {
  assert.equal(resolveWorkspaceSidebarPanelSurfaceClassName({ presentation: "inline" }), "");
  const drawerSurface = resolveWorkspaceSidebarPanelSurfaceClassName({ presentation: "drawer" });
  assert.ok(drawerSurface.includes("bg-background"));
});

test("抽屉显隐由 translate 表达，收起时不占位且不吃指针", () => {
  const open = resolveWorkspaceSidebarPanelPositionClassName({
    presentation: "drawer",
    isSidebarVisible: true,
  });
  const closed = resolveWorkspaceSidebarPanelPositionClassName({
    presentation: "drawer",
    isSidebarVisible: false,
  });
  assert.match(open, /absolute/);
  assert.match(open, /translate-x-0/);
  assert.doesNotMatch(open, /pointer-events-none/);
  assert.match(closed, /-translate-x-full/);
  assert.match(closed, /pointer-events-none/);
});

test("内联列保持原来的定位方式", () => {
  const className = resolveWorkspaceSidebarPanelPositionClassName({
    presentation: "inline",
    isSidebarVisible: true,
  });
  assert.doesNotMatch(className, /absolute/);
  assert.match(className, /flex-none/);
});

test("拖拽手柄只在宽视口且侧栏展开时渲染", () => {
  assert.equal(
    shouldRenderWorkspaceSidebarResizeHandle({ presentation: "inline", isSidebarVisible: true }),
    true,
  );
  assert.equal(
    shouldRenderWorkspaceSidebarResizeHandle({ presentation: "inline", isSidebarVisible: false }),
    false,
  );
  // 覆盖层没有可拖拽的相邻边界。
  assert.equal(
    shouldRenderWorkspaceSidebarResizeHandle({ presentation: "drawer", isSidebarVisible: true }),
    false,
  );
});

test("抽屉遮罩只在窄屏且抽屉展开时渲染", () => {
  assert.equal(
    shouldRenderWorkspaceSidebarBackdrop({ presentation: "drawer", isSidebarVisible: true }),
    true,
  );
  assert.equal(
    shouldRenderWorkspaceSidebarBackdrop({ presentation: "drawer", isSidebarVisible: false }),
    false,
  );
  assert.equal(
    shouldRenderWorkspaceSidebarBackdrop({ presentation: "inline", isSidebarVisible: true }),
    false,
  );
});

// Side Pane 用 wrapper 包裹而不是挪动 DOM：宽屏必须是布局透明的 contents，
// 否则 Browser Guest 会重挂载。
test("Side Pane 包裹层：宽屏透明、窄屏覆盖", () => {
  assert.equal(
    resolveWorkspaceSidePaneWrapperClassName({
      presentation: "inline",
      isSidePaneVisible: true,
    }),
    "contents",
  );
  const drawer = resolveWorkspaceSidePaneWrapperClassName({
    presentation: "drawer",
    isSidePaneVisible: true,
  });
  assert.match(drawer, /absolute/);
  assert.match(drawer, /right-0/);
  // 面板必须压过遮罩，遮罩必须压过会话列自带的 z-10/z-20。
  const wrapperZ = Number(/z-\[(\d+)\]/.exec(drawer)?.[1]);
  const backdropZ = Number(/z-(\d+)/.exec(WORKSPACE_SIDE_PANE_BACKDROP_Z_CLASS)?.[1]);
  assert.ok(wrapperZ > backdropZ, "Side Pane 面板层级必须高于自身遮罩");
  assert.ok(backdropZ > 20, "Side Pane 遮罩必须高于会话列内部层级");
});

// 包裹层的尺寸来自它自身的宽度与 inset-y-0，与内部面板是否收起无关。不置为惰性，
// 它就会在收起状态下变成一块 92vw 宽的透明遮罩，吃掉会话列的指针与触摸事件，
// 表现为消息列表划不动、输入区点不到。
test("Side Pane 包裹层：面板收起时必须惰性", () => {
  const open = resolveWorkspaceSidePaneWrapperClassName({
    presentation: "drawer",
    isSidePaneVisible: true,
  });
  const closed = resolveWorkspaceSidePaneWrapperClassName({
    presentation: "drawer",
    isSidePaneVisible: false,
  });
  assert.match(closed, /pointer-events-none/);
  assert.doesNotMatch(open, /pointer-events-none/);
  // 收起时几何不能变：改宽度会让分栏组重新测量，也可能让 Browser Guest 重挂载。
  assert.equal(closed.replace(" pointer-events-none", ""), open);
  // 收起态不能靠 transform 或 visibility 表达：前者会成为面板内 fixed 承载层的
  // 包含块，后者会把收起时仍需渲染的截图 surface 一起藏掉。
  assert.doesNotMatch(closed, /translate-x-/);
});

test("Side Pane 遮罩只在窄屏且面板打开时渲染", () => {
  assert.equal(
    shouldRenderWorkspaceSidePaneBackdrop({ presentation: "drawer", isSidePaneOpen: true }),
    true,
  );
  assert.equal(
    shouldRenderWorkspaceSidePaneBackdrop({ presentation: "drawer", isSidePaneOpen: false }),
    false,
  );
  assert.equal(
    shouldRenderWorkspaceSidePaneBackdrop({ presentation: "inline", isSidePaneOpen: true }),
    false,
  );
});

// 覆盖层里父级不再是分栏组的 flex 行，面板的 flex-basis/height 会一起失效退回
// 「宽等于内容、高等于内容」；面板外层 div 的尺寸写在行内 style 上，只能靠子选择器
// 覆盖。少了这两条，面板就只渲染出一个盖住会话的空遮罩。
test("Side Pane 覆盖层：面板必须填满包裹层", () => {
  const drawer = resolveWorkspaceSidePaneWrapperClassName({
    presentation: "drawer",
    isSidePaneVisible: true,
  });
  assert.match(drawer, /flex/);
  assert.match(drawer, /\[&>\[data-panel\]\]:!basis-full/);
  assert.match(drawer, /\[&>\[data-panel\]\]:!h-full/);
  // 宽屏必须保持布局透明，否则面板会被挪出分栏组、Browser Guest 重新挂载。
  assert.equal(
    resolveWorkspaceSidePaneWrapperClassName({
      presentation: "inline",
      isSidePaneVisible: true,
    }),
    "contents",
  );
  // 收起态只叠加惰性，几何一点都不能变。
  assert.match(
    resolveWorkspaceSidePaneWrapperClassName({
      presentation: "drawer",
      isSidePaneVisible: false,
    }),
    /\[&>\[data-panel\]\]:!basis-full/,
  );
});

// 手柄是块级流内元素（带 h-full），在覆盖层的流布局里会占掉一整屏高，
// 把面板整体顶出视口——面板渲染了但看不见。
test("Side Pane 拖拽手柄只在分栏形态渲染", () => {
  assert.equal(
    shouldRenderWorkspaceSidePaneResizeHandle({
      presentation: "inline",
      isSidePaneVisible: true,
    }),
    true,
  );
  assert.equal(
    shouldRenderWorkspaceSidePaneResizeHandle({
      presentation: "inline",
      isSidePaneVisible: false,
    }),
    false,
  );
  assert.equal(
    shouldRenderWorkspaceSidePaneResizeHandle({
      presentation: "drawer",
      isSidePaneVisible: true,
    }),
    false,
  );
});

test("Side Pane 展开尺寸：分栏用占比，覆盖层占满包裹层", () => {
  assert.equal(resolveWorkspaceSidePaneExpandedSize({ presentation: "inline" }), "45%");
  assert.equal(resolveWorkspaceSidePaneExpandedSize({ presentation: "drawer" }), "100%");
});

// 左右两个覆盖层共用同一套表面语义，观感必须一致。
test("Side Pane 覆盖层与左侧抽屉共用同一套表面", () => {
  assert.equal(resolveWorkspaceSidePanePanelSurfaceClassName({ presentation: "inline" }), "");
  const sidePaneSurface = resolveWorkspaceSidePanePanelSurfaceClassName({
    presentation: "drawer",
  });
  assert.equal(sidePaneSurface, WORKSPACE_OVERLAY_PANEL_SURFACE_CLASS);
  assert.ok(WORKSPACE_OVERLAY_PANEL_SURFACE_CLASS.includes("bg-background"));
  assert.ok(WORKSPACE_OVERLAY_PANEL_SURFACE_CLASS.includes("shadow-xl"));
  assert.ok(
    resolveWorkspaceSidebarPanelSurfaceClassName({ presentation: "drawer" }).includes(
      WORKSPACE_OVERLAY_PANEL_SURFACE_CLASS,
    ),
  );
});

// 抽屉是盖在会话之上的模态覆盖层，它挡住的目标正是用户刚要去的那一页；
// 内联列属于布局本身，切视图后要留在原处。
test("抽屉里点导航项后收起，内联列不收起", () => {
  assert.equal(
    shouldCollapseWorkspaceSidebarAfterNavigation({
      presentation: "drawer",
      isSidebarVisible: true,
    }),
    true,
  );
  assert.equal(
    shouldCollapseWorkspaceSidebarAfterNavigation({
      presentation: "drawer",
      isSidebarVisible: false,
    }),
    false,
  );
  assert.equal(
    shouldCollapseWorkspaceSidebarAfterNavigation({
      presentation: "inline",
      isSidebarVisible: true,
    }),
    false,
  );
});
