import assert from "node:assert/strict";
import test from "node:test";
import { isGlobalTaskListQueryLoading } from "../src/hooks/globalTaskListLoadState.js";

test("首次读取成员关系时阻塞操作", () => {
  assert.equal(
    isGlobalTaskListQueryLoading({
      hasWorkspaceScope: true,
      currentQueryKey: "pinned:workspace-a",
      settledQueryKey: null,
    }),
    true,
  );
});

test("同一 query 的后台刷新不重新进入阻塞 loading", () => {
  assert.equal(
    isGlobalTaskListQueryLoading({
      hasWorkspaceScope: true,
      currentQueryKey: "pinned:workspace-a",
      settledQueryKey: "pinned:workspace-a",
    }),
    false,
  );
});

test("query 改变时立即恢复首次读取门控", () => {
  assert.equal(
    isGlobalTaskListQueryLoading({
      hasWorkspaceScope: true,
      currentQueryKey: "pinned:workspace-b",
      settledQueryKey: "pinned:workspace-a",
    }),
    true,
  );
});

test("关闭菜单暂停查询但不显示 loading", () => {
  assert.equal(
    isGlobalTaskListQueryLoading({
      hasWorkspaceScope: false,
      currentQueryKey: "pinned:workspace-a",
      settledQueryKey: "pinned:workspace-a",
    }),
    false,
  );
});
