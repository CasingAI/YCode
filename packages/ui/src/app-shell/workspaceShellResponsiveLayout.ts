// 工作区外壳的「呈现形态」判定。这里只做纯计算，不读 DOM：
// 外壳把结果翻译成 className / CSS 变量，node --test 则可以直接覆盖这些分支
// （本检出没有 React 渲染测试基建，纯逻辑是唯一能自动化验证的部分）。
//
// 不变式：isSidebarVisible 仍然是「侧栏内容是否显示」的唯一状态源，
// 视口宽度只决定「用什么形态呈现」。避免宽度和显隐两组状态互相写入。

export const WORKSPACE_SIDEBAR_DRAWER_WIDTH_VW = 85;
export const WORKSPACE_SIDEBAR_DRAWER_MAX_WIDTH_PX = 320;

// 覆盖层层级：遮罩 < 抽屉 < DesktopTopOverlay(z-20)。
// 抽屉刻意压在浮层之下，浮层里的侧栏切换按钮因此在抽屉展开时仍然可点，
// 侧栏本身不需要再长出一个折叠控件。
export const WORKSPACE_SIDEBAR_BACKDROP_Z_CLASS = "z-10";
export const WORKSPACE_SIDEBAR_DRAWER_Z_CLASS = "z-[19]";

// Side Pane 覆盖层在 #content 内部，和会话列同处一个层叠上下文，因此不能复用侧栏
// 那一组 shell 级层级：会话列自带的输入区停靠层是 z-10、建议行是 z-20，Side Pane
// 必须整体压过它们，否则遮罩会被输入区盖住、面板会被建议行盖住。
export const WORKSPACE_SIDE_PANE_BACKDROP_Z_CLASS = "z-30";
export const WORKSPACE_SIDE_PANE_WRAPPER_Z_CLASS = "z-[31]";

export type WorkspaceSidebarPresentation = "inline" | "drawer";

export function resolveWorkspaceSidebarPresentation(params: {
  isNarrowViewport: boolean;
}): WorkspaceSidebarPresentation {
  return params.isNarrowViewport ? "drawer" : "inline";
}

// 侧栏占位的宽度值。
export function resolveWorkspaceSidebarPanelWidthCssValue(params: {
  presentation: WorkspaceSidebarPresentation;
  isSidebarVisible: boolean;
  inlineWidthPx: number;
  collapsedInlineWidthPx: number;
}): string {
  if (params.presentation === "drawer") {
    // 抽屉宽度与显隐无关：显隐由 translate-x 表达。如果这里也跟着变 0，
    // 展开/收起就变成宽度动画，滑块会被压扁而不是整体平移。
    return `min(${WORKSPACE_SIDEBAR_DRAWER_WIDTH_VW}vw, ${WORKSPACE_SIDEBAR_DRAWER_MAX_WIDTH_PX}px)`;
  }

  return `${params.isSidebarVisible ? params.inlineWidthPx : params.collapsedInlineWidthPx}px`;
}

// 主内容区的最小宽度 class。
export function resolveWorkspaceContentMinWidthClassName(params: {
  presentation: WorkspaceSidebarPresentation;
}): string {
  // 抽屉模式下侧栏是覆盖层、不占布局宽度。此时内容区若保留 320px 下限，
  // 窄视口下自身就会被顶出可视区，再被外壳的 overflow-hidden 直接裁掉
  // （这正是手机上右侧内容被切断的原因）。
  return params.presentation === "drawer" ? "min-w-0" : "min-w-[320px]";
}

// 侧栏面板自身的表面 class。
export function resolveWorkspaceSidebarPanelSurfaceClassName(params: {
  presentation: WorkspaceSidebarPresentation;
}): string {
  // 内联列本来就铺在外壳背景上，不需要自带底色；抽屉是浮在会话之上的覆盖层，
  // 没有不透明表面就会透出下面的会话内容，两层文字互相叠印。
  return params.presentation === "drawer" ? "bg-background border-r border-border shadow-xl" : "";
}

// 主内容区自身的层级隔离 class。
export function resolveWorkspaceContentIsolationClassName(params: {
  presentation: WorkspaceSidebarPresentation;
}): string {
  // 会话列内部自带 z-10（输入区停靠层）和 z-20（建议行）等定位层。它们在宽屏只是
  // 列内局部层级，窄屏却会逃逸到根层叠上下文：遮罩(z-10)会因 DOM 顺序落后被输入区
  // 盖住而点不到，抽屉(z-19)也会被 z-20 的建议行压过去。给内容区建立独立层叠上下文，
  // 把列内层级关在里面，外壳的遮罩/抽屉/浮层才能稳定压在其上。
  return params.presentation === "drawer" ? "isolate" : "";
}

// 侧栏面板自身的定位 class。
export function resolveWorkspaceSidebarPanelPositionClassName(params: {
  presentation: WorkspaceSidebarPresentation;
  isSidebarVisible: boolean;
}): string {
  if (params.presentation === "inline") {
    // 与改动前的 class 保持一致：内联列作为 flex 子项参与布局，不引入定位上下文。
    return "flex-none";
  }

  const drawerPosition = `absolute inset-y-0 left-0 ${WORKSPACE_SIDEBAR_DRAWER_Z_CLASS}`;
  return params.isSidebarVisible
    ? `${drawerPosition} translate-x-0`
    : `${drawerPosition} pointer-events-none -translate-x-full`;
}

// 侧栏宽度拖拽手柄是否渲染。
export function shouldRenderWorkspaceSidebarResizeHandle(params: {
  presentation: WorkspaceSidebarPresentation;
  isSidebarVisible: boolean;
}): boolean {
  // 抽屉是覆盖层，没有可拖拽的相邻边界，宽度由视口比例决定。
  return params.presentation === "inline" && params.isSidebarVisible;
}

// 抽屉遮罩是否渲染。遮罩点击即关闭抽屉。
export function shouldRenderWorkspaceSidebarBackdrop(params: {
  presentation: WorkspaceSidebarPresentation;
  isSidebarVisible: boolean;
}): boolean {
  return params.presentation === "drawer" && params.isSidebarVisible;
}

// Side Pane 的包裹层 class。
export function resolveWorkspaceSidePaneWrapperClassName(params: {
  presentation: WorkspaceSidebarPresentation;
  isSidePaneVisible: boolean;
}): string {
  // 宽屏下 wrapper 用 display:contents 对布局透明，Side Pane 继续作为分栏子节点
  // 参与测量；窄屏才转成右侧覆盖层。之所以加 wrapper 而不是把面板挪出分栏组，
  // 是因为 Browser Guest Host 一旦重挂载就会销毁远端浏览器 guest。
  if (params.presentation !== "drawer") {
    return "contents";
  }

  const overlayClassName = `absolute inset-y-0 right-0 ${WORKSPACE_SIDE_PANE_WRAPPER_Z_CLASS} w-[min(92vw,420px)]`;
  if (params.isSidePaneVisible) {
    return overlayClassName;
  }

  // 包裹层的尺寸来自它自身盒子的显式宽度与 inset-y-0，和内部面板是否收起无关：
  // 面板塌成 0 宽，它仍是满高、92vw 宽的透明盒。透明盒照样是命中目标，收起状态下
  // 会吃掉会话列的指针与触摸事件（消息列表划不动、输入区点不到）。这与侧栏抽屉
  // 收起时带 pointer-events-none -translate-x-full 是同一条不变式。
  // 这里只用 pointer-events-none：不加 translate-*（transform 会成为面板内 fixed
  // 承载层的包含块），也不用 visibility/display（截图 surface 收起时仍要渲染面板）。
  return `${overlayClassName} pointer-events-none`;
}

// Side Pane 覆盖层的遮罩是否渲染。
export function shouldRenderWorkspaceSidePaneBackdrop(params: {
  presentation: WorkspaceSidebarPresentation;
  isSidePaneOpen: boolean;
}): boolean {
  return params.presentation === "drawer" && params.isSidePaneOpen;
}
