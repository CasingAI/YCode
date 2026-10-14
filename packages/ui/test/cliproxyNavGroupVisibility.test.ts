import assert from "node:assert/strict";
import test from "node:test";
import { isModelProviderNavGroupVisible } from "../src/settings/model-provider-section/Navigation.js";
import type { ModelProviderNavGroup } from "../src/settings/model-provider-section/constants.js";

// 左栏空分组隐藏规则：所有分组一律按"有条目才显示"，没有特殊分组。
// "有条目"按 items 计（含禁用 provider），不按启用态误判。

function group(id: ModelProviderNavGroup["id"], count: number): ModelProviderNavGroup {
  return {
    id,
    title: id,
    items: Array.from({ length: count }, (_, index) => ({
      key: `${id}:${index}`,
      type: "custom" as const,
      label: `${id} ${index}`,
      provider: {} as never,
      statusActive: true,
    })),
  };
}

test("空 cliproxy 分组不渲染（用户报的 bug）", () => {
  assert.equal(isModelProviderNavGroupVisible(group("cliproxy", 0)), false);
});

test("空 custom 分组不渲染", () => {
  assert.equal(isModelProviderNavGroupVisible(group("custom", 0)), false);
});

test("空 opencode 分组同样隐藏（无特殊分组）", () => {
  assert.equal(isModelProviderNavGroupVisible(group("opencode", 0)), false);
});

test("有条目时各分组正常渲染", () => {
  assert.equal(isModelProviderNavGroupVisible(group("cliproxy", 1)), true);
  assert.equal(isModelProviderNavGroupVisible(group("custom", 2)), true);
  assert.equal(isModelProviderNavGroupVisible(group("opencode", 1)), true);
});

test("禁用 provider 仍占条目：items 非空即渲染，不按启用态误判", () => {
  const disabled: ModelProviderNavGroup = {
    id: "cliproxy",
    title: "cliproxy",
    items: [
      {
        key: "custom:p1",
        type: "custom" as const,
        label: "Codex",
        provider: {} as never,
        statusActive: false,
      },
    ],
  };
  assert.equal(isModelProviderNavGroupVisible(disabled), true);
});
