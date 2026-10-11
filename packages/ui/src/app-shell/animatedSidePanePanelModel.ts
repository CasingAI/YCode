const MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX = 96;

export type OpenTabLauncherItemId =
  | "selection-side-conversation"
  | "review"
  | "plan-directory"
  | "terminal"
  | "browser"
  | "developer-tools";

export function resolveOpenTabLauncherItemIds({
  developerToolsEnabled,
  hasReviewTab,
  canOpenSelectionSideConversation = false,
  canOpenPlanDirectory = false,
  supportsEmbeddedBrowser = true,
}: {
  developerToolsEnabled: boolean;
  hasReviewTab: boolean;
  canOpenSelectionSideConversation?: boolean;
  canOpenPlanDirectory?: boolean;
  supportsEmbeddedBrowser?: boolean;
}): OpenTabLauncherItemId[] {
  const itemIds: OpenTabLauncherItemId[] = [];

  if (canOpenSelectionSideConversation) {
    itemIds.push("selection-side-conversation");
  }

  if (!hasReviewTab) {
    itemIds.push("review");
  }

  if (canOpenPlanDirectory) {
    itemIds.push("plan-directory");
  }

  itemIds.push("terminal");

  if (supportsEmbeddedBrowser) {
    itemIds.push("browser");
  }

  if (developerToolsEnabled) {
    itemIds.push("developer-tools");
  }

  return itemIds;
}

export function shouldOfferPlanDirectory({
  activeTaskId,
}: {
  activeTaskId: string | null;
}): boolean {
  return Boolean(activeTaskId);
}

export function shouldOfferSelectionSideConversation({
  activeTaskId,
}: {
  activeTaskId: string | null;
}): boolean {
  return Boolean(activeTaskId);
}

export type AnimatedSidePanePanelPresentation = "inline" | "drawer";

/**
 * 宽屏分栏形态下，Side Pane 的手柄与面板是否需要覆盖层包裹。
 *
 * react-resizable-panels 的拖拽命中区（`Je()`）只枚举 Group 根元素的直接子节点
 * （`Array.from(t.children)` 再按 `data-panel` / `data-separator` 配对）：
 * 中间隔一层 `display: contents` 的 div，手柄渲染了也算不出命中区，
 * 右边栏表现为「拖不动」。`display: contents` 只对布局透明，不改变 DOM 父子关系。
 * 因此宽屏下不渲染任何包裹层，手柄与面板直接作为 Group 子节点挂载；
 * 窄屏覆盖层本来就没有手柄，才允许包裹层存在。
 */
export function shouldWrapAnimatedSidePanePanel({
  presentation = "inline",
}: {
  presentation?: AnimatedSidePanePanelPresentation;
} = {}) {
  return presentation === "drawer";
}

export function resolveAnimatedSidePanePanelLayout({
  presentation = "inline",
}: {
  presentation?: AnimatedSidePanePanelPresentation;
} = {}) {
  if (presentation === "drawer") {
    // 覆盖层形态下面板自己就是最终宽度，没有相邻分栏可以拖拽或均分：
    // minSize 的 240px 下限会让面板在窄屏上无法塌到 0 收起，maxSize 的 65%
    // 又会让它永远填不满包裹层，两者都要换成覆盖层的「全宽」语义。
    return {
      collapsedSize: "0px",
      defaultSize: "0px",
      maxSize: "100%",
      minSize: "0px",
      useResizablePanel: true,
    };
  }

  return {
    collapsedSize: "0px",
    defaultSize: "0px",
    maxSize: "65%",
    minSize: "240px",
    useResizablePanel: true,
  };
}

export function shouldRenderPreviewPaneHeavyContent({
  isActiveTab,
  isMediaPreview = false,
  isResizeSettling = false,
  isSidePaneVisible,
  minVisibleInlineSizePx = MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX,
  visibleInlineSizePx,
}: {
  isActiveTab: boolean;
  isMediaPreview?: boolean;
  isResizeSettling?: boolean;
  isSidePaneVisible: boolean;
  minVisibleInlineSizePx?: number;
  visibleInlineSizePx: number | null;
}) {
  if (!isSidePaneVisible || !isActiveTab) {
    return false;
  }

  if (isResizeSettling) {
    // 原生 video/audio 进入 HTML fullscreen 时会触发 resize；如果此时卸载
    // 媒体节点，浏览器会因 fullscreen 元素消失而立即退出全屏。
    return isMediaPreview;
  }

  if (visibleInlineSizePx === null) {
    return true;
  }

  return visibleInlineSizePx >= minVisibleInlineSizePx;
}
