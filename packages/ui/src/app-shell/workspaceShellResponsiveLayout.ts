// 工作区外壳的「呈现形态」判定。这里只做纯计算，不读 DOM：
// 外壳把结果翻译成 className / CSS 变量，node --test 则可以直接覆盖这些分支
// （本检出没有 React 渲染测试基建，纯逻辑是唯一能自动化验证的部分）。
//
// 不变式：isSidebarVisible 仍然是「侧栏内容是否显示」的唯一状态源，
// 视口宽度只决定「用什么形态呈现」。避免宽度和显隐两组状态互相写入。

import { SIDE_PANE_DEFAULT_EXPANDED_SIZE } from "@/app-shell/sidePaneLayout.js";

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

// 左右两侧覆盖层共用的表面：浮在被覆盖内容之上的不透明卡片。
// 缺底色会透出下面的会话文字，缺投影会看起来像内容区的一部分。
export const WORKSPACE_OVERLAY_PANEL_SURFACE_CLASS = "bg-background shadow-xl";

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
  return params.presentation === "drawer"
    ? `${WORKSPACE_OVERLAY_PANEL_SURFACE_CLASS} border-r border-border`
    : "";
}

// Side Pane 覆盖层的表面 class。右侧覆盖层与左侧抽屉是同一类东西，观感保持一致。
export function resolveWorkspaceSidePanePanelSurfaceClassName(params: {
  presentation: WorkspaceSidebarPresentation;
}): string {
  return params.presentation === "drawer" ? WORKSPACE_OVERLAY_PANEL_SURFACE_CLASS : "";
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

  // 抽屉的过渡属性必须和它实际用来位移的属性写在一起，且两者必须一致：
  // 位移由 translate-x-0 / -translate-x-full 表达（CSS transform），因此过渡就必须是
  // transform，而不是 left —— left 被 left-0 钉死、整条生命周期里从不变化，
  // transition-[left] 过渡的是一个不动的属性，抽屉会直接瞬移、看不出滑动。
  // 曾经就踩过一次：过渡类写在组件里、位移类写在这里，两处分头改就对不上了。
  // 现在收进同一个函数，对照 Side Pane（transition-[right] 与 right-* 同函数）的做法。
  const drawerPosition = `absolute inset-y-0 left-0 ${WORKSPACE_SIDEBAR_DRAWER_Z_CLASS} transition-transform`;
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

// 抽屉遮罩是否渲染。遮罩在抽屉形态下常驻挂载：显隐由透明度过渡表达，不再按显隐
// 挂卸——抽屉在滑 200ms、遮罩却瞬切，观感是割裂的（覆盖层出来「很硬」的成因）。
// 隐藏态的可点性由 resolveWorkspaceOverlayBackdropClassName 的 pointer-events-none
// 与组件上的 inert 一并关掉。遮罩点击即关闭抽屉。
export function shouldRenderWorkspaceSidebarBackdrop(params: {
  presentation: WorkspaceSidebarPresentation;
}): boolean {
  return params.presentation === "drawer";
}

// 左右覆盖层遮罩共用的显隐 class。进出都是 200ms ease-out 的透明度过渡，与抽屉的
// translate 滑动、Side Pane 包裹层的 right 滑动同参数，遮罩跟着面板同节奏淡入淡出。
// 隐藏态必须 pointer-events-none：opacity-0 不参与命中测试豁免，全屏透明按钮会吃掉
// 整片内容区的点击——与包裹层收起态的惰性是同一条不变式。
export function resolveWorkspaceOverlayBackdropClassName(params: { isVisible: boolean }): string {
  const transition = "transition-opacity duration-200 ease-out";
  return params.isVisible
    ? `${transition} opacity-100`
    : `${transition} pointer-events-none opacity-0`;
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

  // 窄屏包裹层必须重新给面板提供 flex 上下文。分栏形态下面板的尺寸来自父级 flex 行
  // （高度靠 align-items:stretch 拉伸、宽度靠 flex-basis）；父级换成普通块盒后这两样
  // 一起失效，面板退回 height:auto 按内容塌缩——这正是「覆盖层有阴影没东西」的成因。
  //
  // 面板外层 div 的尺寸是 react-resizable-panels 写在行内 style 上的（display:flex、
  // flex-basis:0、height:auto），行内样式压过 class；而 Panel 的 className 落在内层 div
  // 上、够不到外层，所以只能用子选择器 + !important 改写：
  // - basis-full：把 flex-basis 由 0 改成 100%，面板横向填满包裹层；
  // - h-full：把 height 由 auto 改成 100%，配合 stretch 拿到整屏高度。
  // 覆盖层里没有相邻分栏，尺寸不该再由库的布局推导决定，所以这两条常驻而非只加在展开态。
  //
  // 宽度只在这里写一次，并抽成变量给收起偏移复用：收起要让整块滑到视口右侧之外，
  // 偏移量必须等于盒宽，两处分别写字面量迟早走偏。
  const overlayClassName = [
    // top-12 而不是 inset-y-0：覆盖层宿主是 workspace-body-layout 分栏组
    //（react-resizable-panels 的 Group 自带 relative），它的顶部与 Header 顶部齐平
    //（桌面圆角 inset 的 h-1 drag 条在组外、不占组内高度）。inset-y-0 会让面板从
    // Header 顶部盖起，把原生标题栏和窗控整个压在面板下面；top-12 让出 48px 的
    // Header，面板改为从 Header 底边浮起。遮罩仍 inset-0 盖全屏：点 Header 即关面板。
    `absolute top-12 bottom-0 flex ${WORKSPACE_SIDE_PANE_WRAPPER_Z_CLASS}`,
    "[--workspace-side-pane-overlay-width:min(92vw,420px)]",
    "w-[var(--workspace-side-pane-overlay-width)]",
    "[&>[data-panel]]:!basis-full [&>[data-panel]]:!h-full",
    // 开合动画落在包裹层的水平位置（right）上，与左侧抽屉同为 200ms ease-out。
    // 不用 transform/translate：它会让包裹层成为内部 position: fixed 承载层
    // （browser-use 截图 surface）的包含块。right 是布局属性，不改包含块；
    // 滑动期间盒宽不变，逐帧只有这个绝对定位盒子被重新摆放，内部不重排。
    "transition-[right] duration-200 ease-out",
  ].join(" ");
  if (params.isSidePaneVisible) {
    return `${overlayClassName} right-0`;
  }

  // 包裹层的尺寸来自它自身盒子的显式宽度与 top/bottom 偏移，和内部面板是否收起无关：
  // 面板塌成 0 宽，它仍是满高、92vw 宽的透明盒。透明盒照样是命中目标，收起状态下
  // 会吃掉会话列的指针与触摸事件（消息列表划不动、输入区点不到）。这与侧栏抽屉
  // 收起时带 pointer-events-none -translate-x-full 是同一条不变式。
  // 这里只用 pointer-events-none，藏起来靠滑出视口：不用 visibility/display，
  // 因为截图 surface 收起时仍要渲染面板。
  return `${overlayClassName} right-[calc(-1*var(--workspace-side-pane-overlay-width))] pointer-events-none`;
}

// Side Pane 覆盖层展开时占满包裹层宽度：覆盖层本身就是面板的最终宽度，
// 不再有「分栏占比」这一说（分栏形态才用 SIDE_PANE_DEFAULT_EXPANDED_SIZE）。
export function resolveWorkspaceSidePaneExpandedSize(params: {
  presentation: WorkspaceSidebarPresentation;
}): string {
  return params.presentation === "drawer" ? "100%" : SIDE_PANE_DEFAULT_EXPANDED_SIZE;
}

// Side Pane 的宽度拖拽手柄是否渲染。
export function shouldRenderWorkspaceSidePaneResizeHandle(params: {
  presentation: WorkspaceSidebarPresentation;
  isSidePaneVisible: boolean;
}): boolean {
  // 覆盖层没有可拖拽的相邻边界；而且手柄是块级流内元素（带 h-full），在块级包裹层里
  // 会变成一整块整高占位，把面板顶到视口外——面板渲染了但看不见。
  return params.presentation === "inline" && params.isSidePaneVisible;
}

// 抽屉形态下，从抽屉里发起的导航动作完成后是否收起抽屉。
export function shouldCollapseWorkspaceSidebarAfterNavigation(params: {
  presentation: WorkspaceSidebarPresentation;
  isSidebarVisible: boolean;
}): boolean {
  // 抽屉盖住的目标正是用户刚要去的那一页，动作完成即收起；内联列不收起，
  // 侧栏是布局的一部分，切视图后留在原处。
  return params.presentation === "drawer" && params.isSidebarVisible;
}

// Side Pane 覆盖层的遮罩是否渲染。与抽屉遮罩同一条规则：抽屉形态下常驻挂载，
// 显隐走透明度过渡（resolveWorkspaceOverlayBackdropClassName），不按开合挂卸。
// 「面板打开」这一轴仍是调用方合成可见态的依据，只是不再决定挂载。
export function shouldRenderWorkspaceSidePaneBackdrop(params: {
  presentation: WorkspaceSidebarPresentation;
}): boolean {
  return params.presentation === "drawer";
}

// 工作区 Header 是否渲染。
export function shouldRenderWorkspaceHeader(params: {
  /** 当前主视图是否走 WorkspaceHeader（automations / plugin-store 走各自的面包屑带）。 */
  isMainViewHeaderEligible: boolean;
}): boolean {
  // 签名里刻意没有任何侧栏显隐或视口宽度的入参。
  //
  // Header 在正文流里占 48px，它出现或消失会整体顶动正文，因此渲染与否必须是主视图的
  // 单一函数。此前判据里含 !isSidebarVisible：桌面恒真、任务态被 activeTaskId 兜住，
  // 唯独网页版草稿态（新建、无活动任务）会退化成 !isSidebarVisible，于是开关抽屉时
  // Header 整条增删、正文被顶起又落回 48px。
  return params.isMainViewHeaderEligible;
}

// Header 标题区容器是否吸收剩余宽度。
function shouldFillWorkspaceHeaderTitleSection(params: { isNarrowViewport: boolean }): boolean {
  // Header 的直接子级只有左区（flex-1）和右区（shrink-0），富余宽度全部堆在左区内部；
  // 左区里的标题区按内容占宽，富余就会停在标题区之外变成不可回收的空白。
  // 窄视口下（桌面窄窗口与网页一致）让标题区容器吃掉富余；桌面端拖拽区的保留
  // 见 resolveWorkspaceHeaderTitleSectionAppRegionClassName 与标题自身的 grow 判定。
  return params.isNarrowViewport;
}

// Header 标题自身是否 grow 吃掉标题区内的富余。
function shouldFillWorkspaceHeaderTitle(params: {
  isNarrowViewport: boolean;
  isDesktop: boolean;
}): boolean {
  // 网页没有原生标题栏，这段空白既不能拖窗口、也没有别的用途，窄视口下让标题吃掉它。
  // 桌面窄窗口不一样：header 同时是 mac/Windows 的标题栏。标题区容器在窄窗口下已转成
  // 可拖（no-drag 下移到了按钮与标题文本上），标题一旦 grow，它 no-drag 的盒子就会
  // 把短标题之外的富余全部盖成不可拖。标题按内容占宽，富余留在容器上继续当拖拽区；
  // 超长标题靠既有 min-w-0 + shrink + truncate 链路撑满容器内可用空间，不再需要 vw 上限。
  return params.isNarrowViewport && !params.isDesktop;
}

// Header 标题区容器的 class。
export function resolveWorkspaceHeaderTitleSectionClassName(params: {
  isNarrowViewport: boolean;
  isDesktop: boolean;
}): string {
  return shouldFillWorkspaceHeaderTitleSection(params) ? "flex-1" : "";
}

// Header 标题区容器的 app-region class。
export function resolveWorkspaceHeaderTitleSectionAppRegionClassName(params: {
  isNarrowViewport: boolean;
  isDesktop: boolean;
}): string {
  // 宽视口与网页版维持容器整体 no-drag：容器按内容占宽时两者没有可感知差异，
  // 不做顺手放宽（宽视口的容器查询护栏按原样保留，见标题自身 class 的判定）。
  // 桌面窄窗口必须放开：容器 flex-1 后空白全在容器上，整体 no-drag 会把
  // 原生标题栏中段整段变成不可拖；no-drag 下移到容器内的按钮与标题文本。
  if (shouldFillWorkspaceHeaderTitleSection(params) && params.isDesktop) {
    return "";
  }
  return "[app-region:no-drag]";
}

// Header 标题自身的 class。
export function resolveWorkspaceHeaderTitleClassName(params: {
  isNarrowViewport: boolean;
  isDesktop: boolean;
}): string {
  // 标题区变宽后，里面还站着文件夹和「…」两个按钮，标题自己也要 grow 才能吃到富余。
  if (shouldFillWorkspaceHeaderTitle(params)) {
    return "flex-1";
  }

  // 桌面窄窗口：容器已吃掉富余且空白保持可拖，标题按内容占宽即可——超长时由
  // min-w-12 max-w-100 shrink truncate 这条既有链路撑满容器内可用空间，vw 上限
  // 只会把 380px 窗口下的标题压到一个字（22vw≈84px），不再使用。
  if (shouldFillWorkspaceHeaderTitleSection(params)) {
    return "";
  }

  // 宽视口一律回退到改动前的容器查询上限，不做任何顺手放宽：那两条判的是 header
  // 自身宽度而不是视口宽度，宽视口下只要会话列被侧栏和 Side Pane 挤窄（≤560px）
  // 同样会命中，删掉就是宽视口的真实回归。
  return [
    "@max-[560px]/workspace-header:max-w-[30vw]",
    "@max-[420px]/workspace-header:max-w-[22vw]",
  ].join(" ");
}
