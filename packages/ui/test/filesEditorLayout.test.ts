import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyFilesEditorLayout,
  createFilesEditorLayoutWithViews,
  findFilesEditorGroupForView,
  findFilesEditorGroupsForBuffer,
  focusFilesEditorGroup,
  focusFilesEditorView,
  listFilesEditorGroupIds,
  setFilesEditorBranchRatio,
} from "../src/files-workbench/filesEditorLayout.js";
import {
  moveFilesEditorViewToGroup,
  removeFilesEditorGroup,
  removeFilesEditorView,
  splitFilesEditorViewToEdge,
} from "../src/files-workbench/filesEditorLayoutOperations.js";
import type {
  FilesEditorLayoutNode,
  FilesEditorView,
} from "../src/files-workbench/filesEditorLayout.js";

const viewA: FilesEditorView = { id: "view-a", bufferId: "buffer-a" };
const viewB: FilesEditorView = { id: "view-b", bufferId: "buffer-b" };
const viewC: FilesEditorView = { id: "view-c", bufferId: "buffer-c" };

function leafIds(node: FilesEditorLayoutNode): string[] {
  return node.type === "leaf"
    ? [node.groupId]
    : [...leafIds(node.children[0]), ...leafIds(node.children[1])];
}

function branchNodes(
  node: FilesEditorLayoutNode,
): Extract<FilesEditorLayoutNode, { type: "branch" }>[] {
  return node.type === "leaf"
    ? []
    : [node, ...branchNodes(node.children[0]), ...branchNodes(node.children[1])];
}

test("单组布局按现有顺序初始化并保留有效活动视图", () => {
  const layout = createFilesEditorLayoutWithViews("group-a", [viewA, viewB], "view-b");
  assert.deepEqual(listFilesEditorGroupIds(layout.root), ["group-a"]);
  assert.deepEqual(layout.groups["group-a"]?.views, [viewA, viewB]);
  assert.equal(layout.groups["group-a"]?.activeViewId, "view-b");
  assert.equal(layout.focusedGroupId, "group-a");
});

test("支持四个边缘的方向和顺序映射", () => {
  for (const [edge, direction, newFirst] of [
    ["left", "horizontal", true],
    ["right", "horizontal", false],
    ["top", "vertical", true],
    ["bottom", "vertical", false],
  ] as const) {
    const base = createFilesEditorLayoutWithViews("group-a", [viewA, viewB], "view-a");
    const next = splitFilesEditorViewToEdge(base, "view-a", "group-a", edge, {
      groupId: `group-${edge}`,
      branchId: `branch-${edge}`,
    });
    const branch = branchNodes(next.root)[0];
    assert.equal(branch?.direction, direction);
    assert.equal(
      branch?.children[0].type === "leaf" ? branch.children[0].groupId : "nested",
      newFirst ? `group-${edge}` : "group-a",
    );
    assert.equal(
      branch?.children[1].type === "leaf" ? branch.children[1].groupId : "nested",
      newFirst ? "group-a" : `group-${edge}`,
    );
    assert.equal(next.groups[`group-${edge}`]?.views[0]?.bufferId, "buffer-a");
    assert.equal(
      next.groups["group-a"]?.views.some((view) => view.id === "view-a"),
      false,
    );
    assert.equal(next.focusedGroupId, `group-${edge}`);
  }
});

test("拆分唯一视图自动创建共享同一 buffer 的第二个 view", () => {
  const base = createFilesEditorLayoutWithViews("group-a", [viewA], "view-a");
  const next = splitFilesEditorViewToEdge(base, "view-a", "group-a", "right", {
    groupId: "group-b",
    branchId: "branch-b",
    viewId: "view-a-copy",
  });
  assert.deepEqual(findFilesEditorGroupsForBuffer(next, "buffer-a"), ["group-a", "group-b"]);
  assert.equal(next.groups["group-a"]?.views[0]?.id, "view-a");
  assert.equal(next.groups["group-b"]?.views[0]?.id, "view-a-copy");
  assert.equal(next.groups["group-b"]?.views[0]?.bufferId, "buffer-a");
});

test("嵌套分屏、调整比例并将比例限制在 15%–85%", () => {
  const first = createFilesEditorLayoutWithViews("group-a", [viewA, viewB, viewC]);
  const second = splitFilesEditorViewToEdge(first, "view-a", "group-a", "right", {
    groupId: "group-b",
    branchId: "branch-b",
  });
  const third = splitFilesEditorViewToEdge(second, "view-b", "group-a", "bottom", {
    groupId: "group-c",
    branchId: "branch-c",
  });
  assert.equal(listFilesEditorGroupIds(third.root).length, 3);
  const changed = setFilesEditorBranchRatio(third, "branch-b", 0.99);
  assert.equal(branchNodes(changed.root).find((branch) => branch.id === "branch-b")?.ratio, 0.85);
  const low = setFilesEditorBranchRatio(changed, "branch-c", -1);
  assert.equal(branchNodes(low.root).find((branch) => branch.id === "branch-c")?.ratio, 0.15);
  assert.equal(setFilesEditorBranchRatio(low, "missing", 0.5), low);
});

test("同组重排与跨组移动保持活动项和焦点正确", () => {
  const base = createFilesEditorLayoutWithViews("group-a", [viewA, viewB, viewC], "view-a");
  const reordered = moveFilesEditorViewToGroup(base, "view-a", "group-a", 3);
  assert.deepEqual(
    reordered.groups["group-a"]?.views.map((view) => view.id),
    ["view-b", "view-c", "view-a"],
  );
  assert.equal(reordered.groups["group-a"]?.activeViewId, "view-a");

  const split = splitFilesEditorViewToEdge(base, "view-a", "group-a", "right", {
    groupId: "group-b",
    branchId: "branch-b",
  });
  const moved = moveFilesEditorViewToGroup(split, "view-b", "group-b", 1);
  assert.deepEqual(
    moved.groups["group-a"]?.views.map((view) => view.id),
    ["view-c"],
  );
  assert.deepEqual(
    moved.groups["group-b"]?.views.map((view) => view.id),
    ["view-a", "view-b"],
  );
  assert.equal(moved.focusedGroupId, "group-b");
});

test("跨组移动已在目标组打开的同一 buffer 时聚焦现有视图，不产生重复 Tab", () => {
  const base = createFilesEditorLayoutWithViews("group-a", [viewA]);
  const split = splitFilesEditorViewToEdge(
    base,
    "view-a",
    "group-a",
    "right",
    { groupId: "group-b", branchId: "branch-b", viewId: "view-a-copy" },
    "copy",
  );
  const moved = moveFilesEditorViewToGroup(split, "view-a", "group-b");
  assert.deepEqual(listFilesEditorGroupIds(moved.root), ["group-b"]);
  assert.deepEqual(
    moved.groups["group-b"]?.views.map((view) => view.id),
    ["view-a-copy"],
  );
  assert.equal(moved.groups["group-b"]?.activeViewId, "view-a-copy");
  assert.equal(moved.focusedGroupId, "group-b");
});

test("关闭视图会折叠空组，但不会删除共享 buffer 的其他视图", () => {
  const base = createFilesEditorLayoutWithViews("group-a", [viewA, viewB]);
  const split = splitFilesEditorViewToEdge(
    base,
    "view-a",
    "group-a",
    "right",
    {
      groupId: "group-b",
      branchId: "branch-b",
      viewId: "view-a-copy",
    },
    "copy",
  );
  const closedCopy = removeFilesEditorView(split, "view-a-copy");
  assert.deepEqual(listFilesEditorGroupIds(closedCopy.root), ["group-a"]);
  assert.equal(closedCopy.groups["group-a"]?.views[0]?.bufferId, "buffer-a");
  assert.equal(findFilesEditorGroupForView(closedCopy, "view-a"), "group-a");
});

test("关闭嵌套组会折叠父节点并转移焦点", () => {
  const base = createFilesEditorLayoutWithViews("group-a", [viewA, viewB, viewC]);
  const split = splitFilesEditorViewToEdge(base, "view-a", "group-a", "right", {
    groupId: "group-b",
    branchId: "branch-b",
  });
  const nested = splitFilesEditorViewToEdge(split, "view-b", "group-a", "bottom", {
    groupId: "group-c",
    branchId: "branch-c",
  });
  const closed = removeFilesEditorGroup(nested, "group-c");
  assert.deepEqual(leafIds(closed.root).sort(), ["group-a", "group-b"]);
  assert.equal(branchNodes(closed.root).length, 1);
  assert.equal(closed.groups["group-c"], undefined);
  assert.equal(closed.focusedGroupId, "group-a");
});

test("单组关闭最后一个视图时保留空落点组", () => {
  const base = createFilesEditorLayoutWithViews("group-a", [viewA]);
  const closed = removeFilesEditorView(base, "view-a");
  assert.deepEqual(listFilesEditorGroupIds(closed.root), ["group-a"]);
  assert.deepEqual(closed.groups["group-a"]?.views, []);
  assert.equal(closed.groups["group-a"]?.activeViewId, undefined);
});

test("焦点只能切换到真实存在的组和视图", () => {
  const base = createFilesEditorLayoutWithViews("group-a", [viewA, viewB]);
  assert.equal(focusFilesEditorView(base, "group-a", "missing"), base);
  assert.equal(focusFilesEditorView(base, "missing", "view-a"), base);
  assert.equal(
    focusFilesEditorView(base, "group-a", "view-b").groups["group-a"]?.activeViewId,
    "view-b",
  );
  assert.equal(focusFilesEditorView(base, "group-a", "view-b").focusedGroupId, "group-a");
  assert.equal(focusFilesEditorGroup(base, "missing"), base);
});

// A stable empty layout is useful to callers which open a new file before any tab exists.
test("空布局包含一个有效焦点组", () => {
  const layout = createEmptyFilesEditorLayout("group-empty");
  assert.deepEqual(listFilesEditorGroupIds(layout.root), ["group-empty"]);
  assert.equal(layout.focusedGroupId, "group-empty");
  assert.deepEqual(layout.groups["group-empty"]?.views, []);
});
