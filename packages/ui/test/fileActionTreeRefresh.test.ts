import assert from "node:assert/strict";
import test from "node:test";
import { planWorkspaceFileTreeMutation } from "../src/workspace-file-tree/fileActionTreeRefresh.js";

test("多层展开目录改名后显式重读所有新目录，包括隐藏后代，保留无关展开", () => {
  const expanded = new Set([
    "/work/src",
    "/work/src/a/b",
    "/work/src/a/b/deep",
    "/work/src-other",
    "/work/unrelated",
  ]);
  const plan = planWorkspaceFileTreeMutation({
    workspacePath: "/work",
    expandedPaths: expanded,
    mutation: { kind: "rename", path: "/work/src", name: "lib" },
    result: { changed: true, type: "directory", previousPath: "/work/src", path: "/work/lib" },
  });
  assert.deepEqual(
    plan.expandedPaths,
    new Set([
      "/work/lib",
      "/work/lib/a/b",
      "/work/lib/a/b/deep",
      "/work/src-other",
      "/work/unrelated",
      "/work",
    ]),
  );
  assert.deepEqual(
    new Set(plan.reloadPaths),
    new Set(["/work", "/work/lib", "/work/lib/a/b", "/work/lib/a/b/deep"]),
  );
  assert.equal(
    plan.reloadPaths.some((path) => path.startsWith("/work/src")),
    false,
  );
  assert.equal(expanded.has("/work/src"), true);
  assert.equal(expanded.has("/work/lib"), false);
});

test("目录移动同时刷新源父与目标父，不遗漏迁移后的子目录", () => {
  const plan = planWorkspaceFileTreeMutation({
    workspacePath: "/work",
    expandedPaths: new Set(["/work/left/src", "/work/left/src/sub", "/work/keep"]),
    mutation: { kind: "move", path: "/work/left/src", targetDirectory: "/work/right" },
    result: {
      changed: true,
      type: "directory",
      previousPath: "/work/left/src",
      path: "/work/right/src",
    },
  });
  assert.deepEqual(
    plan.expandedPaths,
    new Set(["/work/right/src", "/work/right/src/sub", "/work/keep", "/work/right"]),
  );
  assert.deepEqual(
    new Set(plan.reloadPaths),
    new Set(["/work/left", "/work/right", "/work/right/src", "/work/right/src/sub"]),
  );
});

test("删除目录只清理本目录和子目录展开，父目录刷新且不重读已删目录", () => {
  const plan = planWorkspaceFileTreeMutation({
    workspacePath: "/work",
    expandedPaths: new Set([
      "/work",
      "/work/src",
      "/work/src/sub",
      "/work/src-other",
      "/work/keep",
    ]),
    mutation: { kind: "delete", path: "/work/src" },
    result: { changed: true, type: "directory", previousPath: "/work/src", path: "/work/src" },
  });
  assert.deepEqual(plan.expandedPaths, new Set(["/work", "/work/src-other", "/work/keep"]));
  assert.deepEqual(plan.reloadPaths, ["/work"]);
});

test("复制目录保留源目录所有展开，只展开及刷新目标父目录", () => {
  const expanded = new Set(["/work/source", "/work/source/sub", "/work/keep"]);
  const plan = planWorkspaceFileTreeMutation({
    workspacePath: "/work",
    expandedPaths: expanded,
    mutation: { kind: "copy", path: "/work/source", targetDirectory: "/work/target" },
    result: {
      changed: true,
      type: "directory",
      previousPath: "/work/source",
      path: "/work/target/source",
    },
  });
  assert.deepEqual(plan.expandedPaths, new Set([...expanded, "/work/target"]));
  assert.deepEqual(plan.reloadPaths, ["/work/target"]);
});

test("Windows路径迁移保持分隔符；无操作不更改展开或发起刷新", () => {
  const plan = planWorkspaceFileTreeMutation({
    workspacePath: "C:\\work",
    expandedPaths: new Set(["C:\\work\\src", "C:\\work\\src\\sub", "C:\\work\\src-other"]),
    mutation: { kind: "rename", path: "C:\\work\\src", name: "lib" },
    result: {
      changed: true,
      type: "directory",
      previousPath: "C:\\work\\src",
      path: "C:\\work\\lib",
    },
  });
  assert.deepEqual(
    plan.expandedPaths,
    new Set(["C:\\work\\lib", "C:\\work\\lib\\sub", "C:\\work\\src-other", "C:\\work"]),
  );
  assert.deepEqual(
    new Set(plan.reloadPaths),
    new Set(["C:\\work", "C:\\work\\lib", "C:\\work\\lib\\sub"]),
  );
  const unchanged = planWorkspaceFileTreeMutation({
    workspacePath: "C:\\work",
    expandedPaths: plan.expandedPaths,
    mutation: { kind: "move", path: "C:\\work\\lib", targetDirectory: "C:\\work" },
    result: { changed: false, type: "directory", path: "C:\\work\\lib" },
  });
  assert.deepEqual(unchanged.expandedPaths, plan.expandedPaths);
  assert.deepEqual(unchanged.reloadPaths, []);
});
