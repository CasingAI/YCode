import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkspaceContentIsolationClassName,
  resolveWorkspaceContentMinWidthClassName,
  resolveWorkspaceOverlayBackdropClassName,
  resolveWorkspaceSidePaneExpandedSize,
  resolveWorkspaceSidePanePanelSurfaceClassName,
  resolveWorkspaceSidePaneWrapperClassName,
  resolveWorkspaceSidebarPanelPositionClassName,
  resolveWorkspaceSidebarPanelSurfaceClassName,
  resolveWorkspaceSidebarPanelWidthCssValue,
  resolveWorkspaceSidebarPresentation,
  shouldCollapseWorkspaceSidebarAfterNavigation,
  resolveWorkspaceHeaderTitleClassName,
  resolveWorkspaceHeaderTitleSectionAppRegionClassName,
  resolveWorkspaceHeaderTitleSectionClassName,
  shouldRenderWorkspaceHeader,
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

// 回归护栏：抽屉的过渡属性必须与实际位移属性同源。
// 位移由 translate-x-*（CSS transform）表达；left 被 left-0 钉死、整条生命周期从不变化，
// 过渡 left 等于过渡一个不动的属性，抽屉直接瞬移。过渡类因此与位移类收在同一个函数里。
test("抽屉的过渡属性必须与实际位移属性一致", () => {
  for (const isSidebarVisible of [true, false]) {
    const classes = resolveWorkspaceSidebarPanelPositionClassName({
      presentation: "drawer",
      isSidebarVisible,
    });
    assert.match(classes, /transition-transform/);
    assert.doesNotMatch(classes, /transition-\[left\]/);
    assert.doesNotMatch(classes, /transition-\[width/);
    // 过渡 transform 的前提是确实用 transform 在位移。
    assert.match(classes, isSidebarVisible ? /translate-x-0/ : /-translate-x-full/);
  }
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

// 遮罩在抽屉形态下常驻挂载：显隐由透明度过渡表达，不按显隐挂卸——抽屉在滑 200ms、
// 遮罩却瞬切，观感是割裂的（覆盖层出来「很硬」的成因）。
test("抽屉遮罩在窄屏常驻渲染，显隐走 200ms 透明度过渡", () => {
  assert.equal(shouldRenderWorkspaceSidebarBackdrop({ presentation: "drawer" }), true);
  assert.equal(shouldRenderWorkspaceSidebarBackdrop({ presentation: "inline" }), false);

  const visible = resolveWorkspaceOverlayBackdropClassName({ isVisible: true });
  const hidden = resolveWorkspaceOverlayBackdropClassName({ isVisible: false });
  assert.match(visible, /opacity-100/);
  assert.doesNotMatch(visible, /pointer-events-none/);
  // 隐藏态必须惰性：opacity-0 不参与命中测试豁免，全屏透明按钮会吃掉整片内容区的点击。
  assert.match(hidden, /pointer-events-none/);
  assert.match(hidden, /opacity-0/);
  for (const className of [visible, hidden]) {
    // 过渡参数必须与抽屉的 translate 滑动同源（200ms ease-out）。
    assert.match(className, /transition-opacity/);
    assert.match(className, /duration-200/);
    assert.match(className, /ease-out/);
  }
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
  // 覆盖层宿主（workspace-body-layout 分栏组）顶部与 Header 顶齐平，
  // top-12 让出 48px 的 Header：面板从 Header 底边浮起，不盖原生标题栏。
  assert.match(drawer, /top-12/);
  assert.match(drawer, /bottom-0/);
  assert.doesNotMatch(drawer, /inset-y-0/);
  // 面板必须压过遮罩，遮罩必须压过会话列自带的 z-10/z-20。
  const wrapperZ = Number(/z-\[(\d+)\]/.exec(drawer)?.[1]);
  const backdropZ = Number(/z-(\d+)/.exec(WORKSPACE_SIDE_PANE_BACKDROP_Z_CLASS)?.[1]);
  assert.ok(wrapperZ > backdropZ, "Side Pane 面板层级必须高于自身遮罩");
  assert.ok(backdropZ > 20, "Side Pane 遮罩必须高于会话列内部层级");
});

// 包裹层的尺寸来自它自身的宽度与 top-12/bottom-0 偏移，与内部面板是否收起无关。不置为惰性，
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
  // 两态只允许差在水平偏移与惰性上：盒宽必须同源，否则收起态会跟着改宽，
  // 分栏组重新测量、面板在滑动中途重排。
  const geometry = (value: string) =>
    value
      .split(" ")
      .filter((token) => token.startsWith("w-") || token.includes("data-panel"))
      .sort()
      .join(" ");
  assert.equal(geometry(closed), geometry(open));
  assert.equal(
    geometry(open),
    "[&>[data-panel]]:!basis-full [&>[data-panel]]:!h-full w-[var(--workspace-side-pane-overlay-width)]",
  );
  // 收起态不能靠 transform 或 visibility 表达：前者会成为面板内 fixed 承载层的
  // 包含块，后者会把收起时仍需渲染的截图 surface 一起藏掉。
  assert.doesNotMatch(closed, /translate-x-/);
  for (const className of [open, closed]) {
    assert.doesNotMatch(className, /(^|\s)transform(\s|$)/);
    assert.doesNotMatch(className, /\b(hidden|invisible|collapse|opacity-0)\b/);
  }
});

// 右侧覆盖层原先只有面板那层 200ms opacity，盒子上来就在最终几何位置，
// 看上去是"凭空出现"；左侧抽屉同期是 200ms 的 translate 滑动。这里把位移
// 补到包裹层的 right 上，参数与抽屉对齐。
test("Side Pane 覆盖层：开合是 200ms 的 right 滑动", () => {
  const open = resolveWorkspaceSidePaneWrapperClassName({
    presentation: "drawer",
    isSidePaneVisible: true,
  });
  const closed = resolveWorkspaceSidePaneWrapperClassName({
    presentation: "drawer",
    isSidePaneVisible: false,
  });
  for (const className of [open, closed]) {
    assert.match(className, /transition-\[right\]/);
    assert.match(className, /duration-200/);
    assert.match(className, /ease-out/);
  }
  assert.match(open, /(^|\s)right-0(\s|$)/);
  // 收起偏移必须等于盒宽本身，整块滑到视口右侧之外；两者共用同一个 CSS 变量，
  // 分别写字面量迟早走偏。取负值写成 calc(-1*var(...)) 而不是 -right-...，
  // 避免 Tailwind 的负值语法与任意值里的减法混淆。
  assert.match(closed, /right-\[calc\(-1\*var\(--workspace-side-pane-overlay-width\)\)\]/);
  assert.match(open, /\[--workspace-side-pane-overlay-width:min\(92vw,420px\)\]/);
  // 滑出后由分栏组的 overflow:hidden 裁掉，不需要额外藏匿手段。
  assert.doesNotMatch(closed, /translate-x-|(^|\s)(hidden|invisible)(\s|$)/);
});

// Side Pane 遮罩与抽屉遮罩同一条规则：抽屉形态下常驻挂载，显隐走透明度过渡，
// 不按开合挂卸；「面板打开」只决定可见态，不再决定挂载。
test("Side Pane 遮罩在窄屏常驻渲染，显隐走 200ms 透明度过渡", () => {
  assert.equal(shouldRenderWorkspaceSidePaneBackdrop({ presentation: "drawer" }), true);
  assert.equal(shouldRenderWorkspaceSidePaneBackdrop({ presentation: "inline" }), false);

  const visible = resolveWorkspaceOverlayBackdropClassName({ isVisible: true });
  const hidden = resolveWorkspaceOverlayBackdropClassName({ isVisible: false });
  assert.match(visible, /opacity-100/);
  assert.doesNotMatch(visible, /pointer-events-none/);
  // 收起过程遮罩淡出，但必须立即停止拦截会话列的指针与触摸事件。
  assert.match(hidden, /pointer-events-none/);
  assert.match(hidden, /opacity-0/);
  for (const className of [visible, hidden]) {
    // 与包裹层 right 滑动同参数（200ms ease-out），遮罩跟着面板同节奏淡入淡出。
    assert.match(className, /transition-opacity/);
    assert.match(className, /duration-200/);
    assert.match(className, /ease-out/);
  }
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

// 窄视口下的网页没有原生标题栏可拖，标题吃掉右侧富余宽度；标题区与标题自身
// 都要 flex-1：前者变宽，后者才能在文件夹和「…」之间把剩下的宽度吃掉。
test("窄视口网页版的 Header 标题区与标题吸收富余宽度", () => {
  const params = { isNarrowViewport: true, isDesktop: false };
  assert.equal(resolveWorkspaceHeaderTitleSectionClassName(params), "flex-1");
  assert.equal(resolveWorkspaceHeaderTitleClassName(params), "flex-1");
});

// 桌面窄窗口的 header 同时是 mac/Windows 标题栏。窗口下探到 380px 后 vw 上限会把标题
// 压到一个字（22vw≈84px），因此容器改为 flex-1 吸收富余；拖拽区改由「no-drag 下移到
// 交互子元素」保留，标题自身不 grow——grow 会把短标题之外的富余全盖成 no-drag 盒子。
test("桌面窄窗口的 Header 标题区 flex-1，标题按内容占宽不带 vw 上限", () => {
  const params = { isNarrowViewport: true, isDesktop: true };
  assert.equal(resolveWorkspaceHeaderTitleSectionClassName(params), "flex-1");
  assert.equal(resolveWorkspaceHeaderTitleClassName(params), "");
});

// 容器的 app-region 按形态分流：桌面窄窗口放开让空白跟随父级可拖；
// 宽视口与网页版维持容器整体 no-drag（宽视口容器按内容占宽、无空白，行为不变）。
test("桌面窄窗口的标题区容器放开 no-drag，其余形态维持整体 no-drag", () => {
  assert.equal(
    resolveWorkspaceHeaderTitleSectionAppRegionClassName({
      isNarrowViewport: true,
      isDesktop: true,
    }),
    "",
  );
  for (const params of [
    { isNarrowViewport: true, isDesktop: false },
    { isNarrowViewport: false, isDesktop: true },
    { isNarrowViewport: false, isDesktop: false },
  ]) {
    assert.equal(
      resolveWorkspaceHeaderTitleSectionAppRegionClassName(params),
      "[app-region:no-drag]",
    );
  }
});

test("宽视口下 Header 标题区按内容占宽，标题沿用容器查询上限", () => {
  const containerQueryCaps =
    "@max-[560px]/workspace-header:max-w-[30vw] @max-[420px]/workspace-header:max-w-[22vw]";
  for (const isDesktop of [false, true]) {
    const params = { isNarrowViewport: false, isDesktop };
    assert.equal(resolveWorkspaceHeaderTitleSectionClassName(params), "");
    assert.equal(resolveWorkspaceHeaderTitleClassName(params), containerQueryCaps);
  }
});

// 回归护栏：vw 上限只剩宽视口这一种使用场景。窄视口网页版用 flex-1、桌面窄窗口靠
// 收缩链路都不再带上限；宽视口的容器查询两条判的是 header 容器宽度，宽视口下被
// 侧栏与 Side Pane 挤窄的会话列同样命中，删掉就是宽视口的真实回归。
test("vw 上限只保留在宽视口形态，窄视口两种形态都不再使用", () => {
  const containerQueryCaps =
    "@max-[560px]/workspace-header:max-w-[30vw] @max-[420px]/workspace-header:max-w-[22vw]";

  assert.equal(
    resolveWorkspaceHeaderTitleClassName({ isNarrowViewport: true, isDesktop: false }),
    "flex-1",
  );
  // 桌面窄窗口：标题按内容占宽，靠 min-w-12 max-w-100 shrink truncate 链路收缩。
  assert.equal(
    resolveWorkspaceHeaderTitleClassName({ isNarrowViewport: true, isDesktop: true }),
    "",
  );
  // 宽视口：容器查询照旧。
  for (const isDesktop of [false, true]) {
    assert.equal(
      resolveWorkspaceHeaderTitleClassName({ isNarrowViewport: false, isDesktop }),
      containerQueryCaps,
    );
  }
});

// Header 在正文流里占 48px，出现/消失会整体顶动正文，因此渲染与否只能是主视图的
// 单一函数。此前判据含 !isSidebarVisible，网页版「新建」草稿态退化成它，开关抽屉
// 时 Header 整条增删、正文被顶起又落回 48px。
test("Header 渲染与否只看主视图，与侧栏开关无关", () => {
  assert.equal(shouldRenderWorkspaceHeader({ isMainViewHeaderEligible: true }), true);
  // automations / plugin-store 走各自的面包屑带，仍然不渲染 WorkspaceHeader。
  assert.equal(shouldRenderWorkspaceHeader({ isMainViewHeaderEligible: false }), false);
});

// 回归护栏：判据的入参里不能重新出现侧栏显隐。
//
// 这里不写 arity 之类的弱断言——Function.length 不会因为解构里多一个字段而变化，
// 那种测试看起来在护栏、实际护不住。真正的护栏是这个函数的参数类型：调用方一旦
// 传 isSidebarVisible 之类的多余字段，tsc 的多余属性检查就会直接报错。
// 上面的用例只需断言返回值与主视图一一对应。
