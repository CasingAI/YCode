/**
 * 文件工作台的编辑器组布局树。
 *
 * Layout view 与 FilesBuffer 分离：多个 view 可以引用同一个 bufferId，
 * 因而分屏只是创建/移动视图，不会复制正文或保存状态。
 */
export type FilesEditorSplitDirection = "horizontal" | "vertical";
export type FilesEditorSplitEdge = "left" | "right" | "top" | "bottom";

/** Markdown 源码 / 预览展示模式；源码是默认值。 */
export type FilesEditorMarkdownViewMode = "source" | "preview";

export interface FilesEditorView {
  /** 编辑器视图的唯一身份；同一 buffer 在不同组中可以有多个 view。 */
  id: string;
  /** 指向 FilesEditorStore 中唯一的文件缓冲。 */
  bufferId: string;
  /**
   * Markdown 展示模式，按 view 保存（不按 buffer），因此分屏可同文一源码一预览。
   * 运行时 layout 字段，不写入持久化会话；源码默认时省略。
   */
  markdownViewMode?: FilesEditorMarkdownViewMode;
}

export interface FilesEditorGroup {
  id: string;
  views: FilesEditorView[];
  activeViewId?: string;
}

export type FilesEditorLayoutNode =
  | { type: "leaf"; groupId: string }
  | {
      type: "branch";
      id: string;
      direction: FilesEditorSplitDirection;
      children: [FilesEditorLayoutNode, FilesEditorLayoutNode];
      /** 第一个子区域的占比，限制在 15%–85%。 */
      ratio: number;
    };

export interface FilesEditorLayoutState {
  root: FilesEditorLayoutNode;
  groups: Record<string, FilesEditorGroup>;
  focusedGroupId: string;
}

export interface FilesEditorSplitIds {
  groupId: string;
  branchId: string;
  /** copy 模式必填；必须是全局唯一的 view id。 */
  viewId?: string;
}

const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

function withActiveView(group: FilesEditorGroup, preferredViewId?: string): FilesEditorGroup {
  if (group.views.length === 0) {
    return { ...group, activeViewId: undefined };
  }
  if (preferredViewId && group.views.some((view) => view.id === preferredViewId)) {
    return { ...group, activeViewId: preferredViewId };
  }
  if (group.activeViewId && group.views.some((view) => view.id === group.activeViewId)) {
    return group;
  }
  return { ...group, activeViewId: group.views[0]?.id };
}

function listNodeGroupIds(node: FilesEditorLayoutNode): string[] {
  if (node.type === "leaf") return [node.groupId];
  return [...listNodeGroupIds(node.children[0]), ...listNodeGroupIds(node.children[1])];
}

function groupContainsView(group: FilesEditorGroup, viewId: string): boolean {
  return group.views.some((view) => view.id === viewId);
}

/** 创建一个空编辑器组；调用方负责提供稳定且唯一的 group id。 */
export function createEmptyFilesEditorLayout(groupId: string): FilesEditorLayoutState {
  return {
    root: { type: "leaf", groupId },
    groups: { [groupId]: { id: groupId, views: [] } },
    focusedGroupId: groupId,
  };
}

/** 从已有打开标签建立初始单组布局，保持原有 Tab 顺序与活动项。 */
export function createFilesEditorLayoutWithViews(
  groupId: string,
  views: readonly FilesEditorView[],
  activeViewId?: string,
): FilesEditorLayoutState {
  const copiedViews = views.map((view) => ({ ...view }));
  const group = withActiveView({ id: groupId, views: copiedViews }, activeViewId);
  return {
    root: { type: "leaf", groupId },
    groups: { [groupId]: group },
    focusedGroupId: groupId,
  };
}

export function listFilesEditorGroupIds(node: FilesEditorLayoutNode): string[] {
  return listNodeGroupIds(node);
}

export function findFilesEditorGroupForView(
  layout: FilesEditorLayoutState,
  viewId: string,
): string | undefined {
  return Object.values(layout.groups).find((group) => groupContainsView(group, viewId))?.id;
}

export function findFilesEditorView(
  layout: FilesEditorLayoutState,
  viewId: string,
): FilesEditorView | undefined {
  const groupId = findFilesEditorGroupForView(layout, viewId);
  return groupId ? layout.groups[groupId]?.views.find((view) => view.id === viewId) : undefined;
}

/** 将新视图放入指定组；同组同 buffer 已存在时聚焦现有视图而不重复添加。 */
export function addFilesEditorViewToGroup(
  layout: FilesEditorLayoutState,
  groupId: string,
  view: FilesEditorView,
  index?: number,
): FilesEditorLayoutState {
  const group = layout.groups[groupId];
  if (!group || findFilesEditorGroupForView(layout, view.id)) return layout;
  const existingBufferView = group.views.find((candidate) => candidate.bufferId === view.bufferId);
  if (existingBufferView) return focusFilesEditorView(layout, groupId, existingBufferView.id);
  const insertAt = Math.max(0, Math.min(group.views.length, index ?? group.views.length));
  const views = [...group.views.slice(0, insertAt), { ...view }, ...group.views.slice(insertAt)];
  return {
    ...layout,
    focusedGroupId: groupId,
    groups: {
      ...layout.groups,
      [groupId]: withActiveView({ ...group, views }, view.id),
    },
  };
}

/** 更新视图所指向的缓冲身份；用于「另存为」后保留视图位置。 */
export function replaceFilesEditorViewBuffer(
  layout: FilesEditorLayoutState,
  viewId: string,
  bufferId: string,
): FilesEditorLayoutState {
  const groupId = findFilesEditorGroupForView(layout, viewId);
  const group = groupId ? layout.groups[groupId] : undefined;
  if (!group || !groupId) return layout;
  const view = group.views.find((candidate) => candidate.id === viewId);
  if (!view || view.bufferId === bufferId) return layout;
  if (group.views.some((candidate) => candidate.id !== viewId && candidate.bufferId === bufferId)) {
    return layout;
  }
  return {
    ...layout,
    groups: {
      ...layout.groups,
      [groupId]: {
        ...group,
        views: group.views.map((candidate) =>
          // 同一 view 换到另一个 buffer 时，旧的 Markdown 预览模式不再适用。
          candidate.id === viewId
            ? { ...candidate, bufferId, markdownViewMode: undefined }
            : candidate,
        ),
      },
    },
  };
}

/**
 * 设置某个 view 的 Markdown 展示模式。
 *
 * 只改运行时 layout：不触碰 buffer / 正文 / 脏态，也不触发持久化。
 * `source` 是默认值，写入时删除字段；未知 view 是幂等 no-op。
 */
export function setFilesEditorViewMarkdownViewMode(
  layout: FilesEditorLayoutState,
  viewId: string,
  mode: FilesEditorMarkdownViewMode,
): FilesEditorLayoutState {
  const groupId = findFilesEditorGroupForView(layout, viewId);
  const group = groupId ? layout.groups[groupId] : undefined;
  if (!group || !groupId) return layout;
  const view = group.views.find((candidate) => candidate.id === viewId);
  if (!view) return layout;
  const nextMode = mode === "preview" ? "preview" : undefined;
  if (view.markdownViewMode === nextMode) return layout;
  return {
    ...layout,
    groups: {
      ...layout.groups,
      [groupId]: {
        ...group,
        views: group.views.map((candidate) =>
          candidate.id === viewId ? { ...candidate, markdownViewMode: nextMode } : candidate,
        ),
      },
    },
  };
}

export function findFilesEditorGroupsForBuffer(
  layout: FilesEditorLayoutState,
  bufferId: string,
): string[] {
  return Object.values(layout.groups)
    .filter((group) => group.views.some((view) => view.bufferId === bufferId))
    .map((group) => group.id);
}

export function focusFilesEditorGroup(
  layout: FilesEditorLayoutState,
  groupId: string,
): FilesEditorLayoutState {
  if (!layout.groups[groupId] || layout.focusedGroupId === groupId) return layout;
  return { ...layout, focusedGroupId: groupId };
}

export function focusFilesEditorView(
  layout: FilesEditorLayoutState,
  groupId: string,
  viewId: string,
): FilesEditorLayoutState {
  const group = layout.groups[groupId];
  if (!group || !groupContainsView(group, viewId)) return layout;
  if (layout.focusedGroupId === groupId && group.activeViewId === viewId) return layout;
  return {
    ...layout,
    focusedGroupId: groupId,
    groups: {
      ...layout.groups,
      [groupId]: { ...group, activeViewId: viewId },
    },
  };
}

/** 调整分隔线比例；非法 id 不改变布局，比例始终受上下限约束。 */
export function setFilesEditorBranchRatio(
  layout: FilesEditorLayoutState,
  branchId: string,
  ratio: number,
): FilesEditorLayoutState {
  let changed = false;
  const nextRatio = clampRatio(ratio);
  const mapNode = (node: FilesEditorLayoutNode): FilesEditorLayoutNode => {
    if (node.type === "leaf") return node;
    if (node.id === branchId) {
      if (node.ratio === nextRatio) return node;
      changed = true;
      return { ...node, ratio: nextRatio };
    }
    const first = mapNode(node.children[0]);
    const second = mapNode(node.children[1]);
    if (first === node.children[0] && second === node.children[1]) return node;
    return { ...node, children: [first, second] };
  };
  const root = mapNode(layout.root);
  return changed ? { ...layout, root } : layout;
}
