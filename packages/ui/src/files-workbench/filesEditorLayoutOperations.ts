import { findFilesEditorGroupForView } from "@/files-workbench/filesEditorLayout.js";
import type {
  FilesEditorGroup,
  FilesEditorLayoutNode,
  FilesEditorLayoutState,
  FilesEditorSplitDirection,
  FilesEditorSplitEdge,
  FilesEditorSplitIds,
  FilesEditorView,
} from "@/files-workbench/filesEditorLayout.js";

function withActiveView(group: FilesEditorGroup, preferredViewId?: string): FilesEditorGroup {
  if (group.views.length === 0) return { ...group, activeViewId: undefined };
  if (preferredViewId && group.views.some((view) => view.id === preferredViewId)) {
    return { ...group, activeViewId: preferredViewId };
  }
  if (group.activeViewId && group.views.some((view) => view.id === group.activeViewId)) {
    return group;
  }
  return { ...group, activeViewId: group.views[0]?.id };
}

function replaceLeaf(
  node: FilesEditorLayoutNode,
  groupId: string,
  replacement: FilesEditorLayoutNode,
): FilesEditorLayoutNode {
  if (node.type === "leaf") return node.groupId === groupId ? replacement : node;
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], groupId, replacement),
      replaceLeaf(node.children[1], groupId, replacement),
    ],
  };
}

function removeLeaf(
  node: FilesEditorLayoutNode,
  groupId: string,
): FilesEditorLayoutNode | undefined {
  if (node.type === "leaf") return node.groupId === groupId ? undefined : node;
  const left = removeLeaf(node.children[0], groupId);
  const right = removeLeaf(node.children[1], groupId);
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right) return left;
  return { ...node, children: [left, right] };
}

function findFirstGroupId(node: FilesEditorLayoutNode): string {
  if (node.type === "leaf") return node.groupId;
  return findFirstGroupId(node.children[0]);
}

function listNodeGroupIds(node: FilesEditorLayoutNode): string[] {
  if (node.type === "leaf") return [node.groupId];
  return [...listNodeGroupIds(node.children[0]), ...listNodeGroupIds(node.children[1])];
}

function listNodeBranchIds(node: FilesEditorLayoutNode): string[] {
  if (node.type === "leaf") return [];
  return [node.id, ...listNodeBranchIds(node.children[0]), ...listNodeBranchIds(node.children[1])];
}

function groupContainsView(group: FilesEditorGroup, viewId: string): boolean {
  return group.views.some((view) => view.id === viewId);
}

/**
 * 在目标组指定边缘创建新组，并把视图移动到新组。
 * 若在同一组中拆分唯一视图，则自动改为复制视图，确保分屏操作有意义；
 * 复制只产生新的 view id，bufferId 保持不变。
 */
export function splitFilesEditorViewToEdge(
  layout: FilesEditorLayoutState,
  viewId: string,
  targetGroupId: string,
  edge: FilesEditorSplitEdge,
  ids: FilesEditorSplitIds,
  mode: "move" | "copy" = "move",
): FilesEditorLayoutState {
  const sourceGroupId = findFilesEditorGroupForView(layout, viewId);
  const sourceGroup = sourceGroupId ? layout.groups[sourceGroupId] : undefined;
  const targetGroup = layout.groups[targetGroupId];
  if (!sourceGroup || !sourceGroupId || !targetGroup) return layout;
  if (layout.groups[ids.groupId] || listNodeGroupIds(layout.root).includes(ids.groupId))
    return layout;
  if (!ids.branchId.trim() || listNodeBranchIds(layout.root).includes(ids.branchId)) return layout;

  const sourceView = sourceGroup.views.find((view) => view.id === viewId);
  if (!sourceView) return layout;

  let effectiveMode = mode;
  if (sourceGroupId === targetGroupId && sourceGroup.views.length === 1) {
    effectiveMode = "copy";
  }
  if (effectiveMode === "copy") {
    if (!ids.viewId || ids.viewId === viewId) return layout;
    const existingView = Object.values(layout.groups).some((group) =>
      groupContainsView(group, ids.viewId!),
    );
    if (existingView) return layout;
  }

  const direction: FilesEditorSplitDirection =
    edge === "left" || edge === "right" ? "horizontal" : "vertical";
  const newFirst = edge === "left" || edge === "top";
  const newView: FilesEditorView =
    effectiveMode === "copy" ? { id: ids.viewId!, bufferId: sourceView.bufferId } : sourceView;
  const newGroup: FilesEditorGroup = {
    id: ids.groupId,
    views: [newView],
    activeViewId: newView.id,
  };
  const oldLeaf: FilesEditorLayoutNode = { type: "leaf", groupId: targetGroupId };
  const newLeaf: FilesEditorLayoutNode = { type: "leaf", groupId: ids.groupId };
  const branch: FilesEditorLayoutNode = {
    type: "branch",
    id: ids.branchId,
    direction,
    ratio: 0.5,
    children: newFirst ? [newLeaf, oldLeaf] : [oldLeaf, newLeaf],
  };

  let groups: Record<string, FilesEditorGroup> = {
    ...layout.groups,
    [ids.groupId]: newGroup,
  };
  if (effectiveMode === "move") {
    groups[sourceGroupId] = withActiveView(
      {
        ...sourceGroup,
        views: sourceGroup.views.filter((view) => view.id !== viewId),
      },
      sourceGroup.activeViewId === viewId ? undefined : sourceGroup.activeViewId,
    );
  }

  let root = replaceLeaf(layout.root, targetGroupId, branch);
  let focusedGroupId = ids.groupId;

  // 仅在移动导致源组为空且源组不是本次分屏锚点时折叠该组。
  if (
    effectiveMode === "move" &&
    sourceGroupId !== targetGroupId &&
    groups[sourceGroupId]?.views.length === 0
  ) {
    const withoutSource = removeLeaf(root, sourceGroupId);
    if (withoutSource) root = withoutSource;
    delete groups[sourceGroupId];
    if (!groups[focusedGroupId]) focusedGroupId = findFirstGroupId(root);
  }

  return { root, groups, focusedGroupId };
}

/** 在组内重排视图，或将视图移动到另一组；空源组自动移除并折叠布局树。 */
export function moveFilesEditorViewToGroup(
  layout: FilesEditorLayoutState,
  viewId: string,
  targetGroupId: string,
  targetIndex?: number,
): FilesEditorLayoutState {
  const sourceGroupId = findFilesEditorGroupForView(layout, viewId);
  const sourceGroup = sourceGroupId ? layout.groups[sourceGroupId] : undefined;
  const targetGroup = layout.groups[targetGroupId];
  if (!sourceGroup || !sourceGroupId || !targetGroup) return layout;

  const currentIndex = sourceGroup.views.findIndex((view) => view.id === viewId);
  if (currentIndex < 0) return layout;
  const view = sourceGroup.views[currentIndex]!;

  if (sourceGroupId !== targetGroupId) {
    const existingTargetView = targetGroup.views.find((entry) => entry.bufferId === view.bufferId);
    if (existingTargetView) {
      const sourceViews = sourceGroup.views.filter((entry) => entry.id !== viewId);
      const groups: Record<string, FilesEditorGroup> = {
        ...layout.groups,
        [targetGroupId]: withActiveView(targetGroup, existingTargetView.id),
      };
      let root = layout.root;
      if (sourceViews.length === 0 && listNodeGroupIds(root).length > 1) {
        const nextRoot = removeLeaf(root, sourceGroupId);
        if (nextRoot) root = nextRoot;
        delete groups[sourceGroupId];
      } else {
        groups[sourceGroupId] = withActiveView(
          { ...sourceGroup, views: sourceViews },
          sourceGroup.activeViewId === viewId ? undefined : sourceGroup.activeViewId,
        );
      }
      const focusedGroupId = groups[targetGroupId] ? targetGroupId : findFirstGroupId(root);
      return { ...layout, root, groups, focusedGroupId };
    }
  }

  if (sourceGroupId === targetGroupId) {
    const without = sourceGroup.views.filter((entry) => entry.id !== viewId);
    let insertAt = targetIndex ?? without.length;
    if (currentIndex < insertAt) insertAt -= 1;
    insertAt = Math.max(0, Math.min(without.length, insertAt));
    const views = [...without.slice(0, insertAt), view, ...without.slice(insertAt)];
    return {
      ...layout,
      focusedGroupId: targetGroupId,
      groups: {
        ...layout.groups,
        [targetGroupId]: withActiveView({ ...sourceGroup, views }, viewId),
      },
    };
  }

  const sourceViews = sourceGroup.views.filter((entry) => entry.id !== viewId);
  const insertAt = Math.max(
    0,
    Math.min(targetGroup.views.length, targetIndex ?? targetGroup.views.length),
  );
  const targetViews = [
    ...targetGroup.views.slice(0, insertAt),
    view,
    ...targetGroup.views.slice(insertAt),
  ];
  const groups: Record<string, FilesEditorGroup> = {
    ...layout.groups,
    [targetGroupId]: withActiveView({ ...targetGroup, views: targetViews }, viewId),
  };
  let root = layout.root;
  let focusedGroupId = targetGroupId;
  if (sourceViews.length === 0 && listNodeGroupIds(root).length > 1) {
    const nextRoot = removeLeaf(root, sourceGroupId);
    if (nextRoot) root = nextRoot;
    delete groups[sourceGroupId];
  } else {
    groups[sourceGroupId] = withActiveView(
      { ...sourceGroup, views: sourceViews },
      sourceGroup.activeViewId === viewId ? undefined : sourceGroup.activeViewId,
    );
  }
  if (!groups[focusedGroupId]) focusedGroupId = findFirstGroupId(root);
  return { ...layout, root, groups, focusedGroupId };
}

/** 关闭一个视图；只在组为空且仍有其他组时清理该组，不触碰 buffer 本身。 */
export function removeFilesEditorViewsForBuffer(
  layout: FilesEditorLayoutState,
  bufferId: string,
): FilesEditorLayoutState {
  const viewIds = Object.values(layout.groups).flatMap((group) =>
    group.views.filter((view) => view.bufferId === bufferId).map((view) => view.id),
  );
  return viewIds.reduce((current, viewId) => removeFilesEditorView(current, viewId), layout);
}

export function removeFilesEditorView(
  layout: FilesEditorLayoutState,
  viewId: string,
): FilesEditorLayoutState {
  const groupId = findFilesEditorGroupForView(layout, viewId);
  const group = groupId ? layout.groups[groupId] : undefined;
  if (!group || !groupId) return layout;
  const views = group.views.filter((view) => view.id !== viewId);
  let groups: Record<string, FilesEditorGroup> = {
    ...layout.groups,
    [groupId]: withActiveView(
      { ...group, views },
      group.activeViewId === viewId ? undefined : group.activeViewId,
    ),
  };
  let root = layout.root;
  let focusedGroupId = layout.focusedGroupId;
  if (views.length === 0 && listNodeGroupIds(root).length > 1) {
    const nextRoot = removeLeaf(root, groupId);
    if (nextRoot) root = nextRoot;
    delete groups[groupId];
    if (focusedGroupId === groupId || !groups[focusedGroupId]) {
      focusedGroupId = findFirstGroupId(root);
    }
  }
  return { ...layout, root, groups, focusedGroupId };
}

/** 关闭整个编辑器组；单组布局始终保留一个空组作为后续打开文件的落点。 */
export function removeFilesEditorGroup(
  layout: FilesEditorLayoutState,
  groupId: string,
): FilesEditorLayoutState {
  if (!layout.groups[groupId]) return layout;
  const groupIds = listNodeGroupIds(layout.root);
  if (groupIds.length === 1) {
    return {
      ...layout,
      groups: { [groupId]: { id: groupId, views: [] } },
      focusedGroupId: groupId,
    };
  }
  const nextRoot = removeLeaf(layout.root, groupId);
  if (!nextRoot) return layout;
  const groups = { ...layout.groups };
  delete groups[groupId];
  const focusedGroupId =
    layout.focusedGroupId === groupId || !groups[layout.focusedGroupId]
      ? findFirstGroupId(nextRoot)
      : layout.focusedGroupId;
  return { ...layout, root: nextRoot, groups, focusedGroupId };
}
