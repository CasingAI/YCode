import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskListQuery } from "@zcode/services";
import {
  buildGlobalTaskListQueryKeys,
  isGlobalTaskListQueryLoading,
  resolveGlobalTaskListDataView,
} from "../src/hooks/globalTaskListLoadState.js";

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

const baseQuery: ZCodeTaskListQuery = {
  kind: "timeline",
  workspaceScopes: [{ workspacePath: "/workspace/a", workspaceIdentity: "remote-a" }],
  sortBy: "updated",
  search: "needle",
};

test("相同查询语义的 limit 不进入展示身份", () => {
  const keys = [20, 40, undefined].map((limit) =>
    buildGlobalTaskListQueryKeys({ ...baseQuery, limit }),
  );
  const displayQueryKey = keys[0]?.displayQueryKey;

  assert.equal(new Set(keys.map((key) => key.displayQueryKey)).size, 1);
  // 完整 queryKey 仍区分分页窗口；undefined 的 limit 不参与 JSON，等于展示身份。
  assert.equal(new Set(keys.map((key) => key.queryKey)).size, 3);
  assert.equal(
    buildGlobalTaskListQueryKeys({ ...baseQuery, limit: 0 }).displayQueryKey,
    displayQueryKey,
  );
});

test("workspace/kind/sort/search/仅标题/含归档变化都会改变展示身份", () => {
  const baseline = buildGlobalTaskListQueryKeys(baseQuery);
  const variants: Array<[string, ZCodeTaskListQuery]> = [
    [
      "workspacePath",
      {
        ...baseQuery,
        workspaceScopes: [{ workspacePath: "/workspace/b", workspaceIdentity: "remote-a" }],
      },
    ],
    [
      "同 path 不同 workspaceIdentity",
      {
        ...baseQuery,
        workspaceScopes: [{ workspacePath: "/workspace/a", workspaceIdentity: "remote-b" }],
      },
    ],
    ["kind", { ...baseQuery, kind: "active" }],
    ["sortBy", { ...baseQuery, sortBy: "created" }],
    ["search", { ...baseQuery, search: "other" }],
    ["searchTitlesOnly", { ...baseQuery, searchTitlesOnly: true }],
    ["includeArchived", { ...baseQuery, includeArchived: true }],
  ];

  for (const [label, query] of variants) {
    const keys = buildGlobalTaskListQueryKeys(query);
    assert.notEqual(keys.displayQueryKey, baseline.displayQueryKey, label);
    assert.notEqual(keys.queryKey, baseline.queryKey, `${label} queryKey`);
  }
});

const firstPage = Array.from({ length: 20 }, (_, index) => index);
const fullList = Array.from({ length: 45 }, (_, index) => index);

function resolveView(params: {
  items: number[];
  total?: number;
  hasMore?: boolean;
  limit?: number;
  dataDisplayQueryKey?: string | null;
  currentDisplayQueryKey?: string;
  hasWorkspaceScope?: boolean;
}) {
  return resolveGlobalTaskListDataView({
    hasWorkspaceScope: params.hasWorkspaceScope ?? true,
    currentDisplayQueryKey: params.currentDisplayQueryKey ?? "timeline:workspace-a",
    // null 表示尚未成功读取过，不能被默认值覆盖。
    dataDisplayQueryKey:
      params.dataDisplayQueryKey === undefined
        ? "timeline:workspace-a"
        : params.dataDisplayQueryKey,
    items: params.items,
    total: params.total ?? params.items.length,
    hasMore: params.hasMore ?? false,
    limit: params.limit,
  });
}

test("显示更多导致 limit 增大时沿用同展示身份的最后成功结果", () => {
  const view = resolveView({
    items: firstPage,
    total: 45,
    hasMore: true,
    limit: 40,
  });

  // 新一页未返回前必须继续展示已读前缀，否则时间线会退回加载提示并把滚动位置拉回顶部。
  assert.equal(view.items, firstPage);
  assert.equal(view.total, 45);
  assert.equal(view.hasMore, true);
});

test("收起导致 limit 缩小时只截断当前窗口，不丢 total 与继续展开能力", () => {
  const view = resolveView({
    items: fullList,
    total: 45,
    hasMore: false,
    limit: 20,
  });

  assert.deepEqual(view.items, firstPage);
  assert.equal(view.total, 45);
  // 上一次全量结果 hasMore=false，但当前窗口只展示 20 行，剩余行仍可继续展开。
  assert.equal(view.hasMore, true);
});

test("limit 为 0 或非正数时按服务约定视为无上限", () => {
  for (const limit of [0, -1]) {
    const view = resolveView({
      items: firstPage,
      total: 45,
      hasMore: true,
      limit,
    });

    assert.equal(view.items, firstPage, `limit=${limit}`);
    assert.equal(view.total, 45, `limit=${limit}`);
    assert.equal(view.hasMore, true, `limit=${limit}`);
  }
});

test("无上限分页沿用最后成功结果，等全量结果返回后再替换", () => {
  const view = resolveView({
    items: firstPage,
    total: 45,
    hasMore: true,
    limit: undefined,
  });

  assert.equal(view.items, firstPage);
  assert.equal(view.total, 45);
  assert.equal(view.hasMore, true);
});

test("items 未超过当前 limit 时保持原数组引用", () => {
  const view = resolveView({
    items: firstPage,
    total: 20,
    hasMore: false,
    limit: 40,
  });

  assert.equal(view.items, firstPage);
  assert.equal(view.hasMore, false);
});

test("展示身份变化时立即隐藏旧查询的行", () => {
  const view = resolveView({
    items: firstPage,
    total: 45,
    hasMore: true,
    limit: 40,
    currentDisplayQueryKey: "timeline:workspace-b",
  });

  assert.deepEqual(view.items, []);
  assert.equal(view.total, 0);
  assert.equal(view.hasMore, false);
});

test("尚未成功读取过展示身份时返回空结果", () => {
  const view = resolveView({
    items: firstPage,
    total: 45,
    hasMore: true,
    limit: 20,
    dataDisplayQueryKey: null,
  });

  assert.deepEqual(view.items, []);
  assert.equal(view.total, 0);
  assert.equal(view.hasMore, false);
});

test("没有 workspace scope 时不展示上一次结果", () => {
  const view = resolveView({
    items: firstPage,
    total: 45,
    hasMore: true,
    limit: 20,
    hasWorkspaceScope: false,
  });

  assert.deepEqual(view.items, []);
  assert.equal(view.total, 0);
  assert.equal(view.hasMore, false);
});
