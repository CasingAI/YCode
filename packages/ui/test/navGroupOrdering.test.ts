import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  NAV_GROUP_CANONICAL_ORDER,
  reorderProviderIdsByNavGroups,
  resolveNavGroupDisplayOrder,
  resolveProviderNavGroupId,
} from "@/settings/model-provider-section/navGroupOrdering.js";

function makeProvider(providerId: string, templateId: string | null): ProviderSettingsFormProvider {
  return {
    providerId,
    providerName: providerId,
    templateId: templateId ?? undefined,
  } as ProviderSettingsFormProvider;
}

test("resolveProviderNavGroupId 按模板前缀归类，其余全部归 custom", () => {
  assert.equal(resolveProviderNavGroupId(makeProvider("a", "opencode-go")), "opencode");
  assert.equal(resolveProviderNavGroupId(makeProvider("a", "opencode-anything")), "opencode");
  assert.equal(resolveProviderNavGroupId(makeProvider("a", "cliproxy-codex")), "cliproxy");
  assert.equal(resolveProviderNavGroupId(makeProvider("a", "deepseek")), "custom");
  assert.equal(resolveProviderNavGroupId(makeProvider("a", null)), "custom");
  assert.equal(resolveProviderNavGroupId(makeProvider("a", undefined)), "custom");
});

test("resolveNavGroupDisplayOrder 未拖动过分组时按 canonical 兜底", () => {
  assert.deepEqual(resolveNavGroupDisplayOrder({}), [...NAV_GROUP_CANONICAL_ORDER]);
  assert.deepEqual(resolveNavGroupDisplayOrder({ explicitGroupOrder: [] }), [
    ...NAV_GROUP_CANONICAL_ORDER,
  ]);
  assert.deepEqual(resolveNavGroupDisplayOrder({ explicitGroupOrder: undefined }), [
    ...NAV_GROUP_CANONICAL_ORDER,
  ]);
});

test("resolveNavGroupDisplayOrder 显式顺序优先且保持用户拖出的次序", () => {
  assert.deepEqual(resolveNavGroupDisplayOrder({ explicitGroupOrder: ["custom", "cliproxy"] }), [
    "custom",
    "cliproxy",
    "opencode",
  ]);
  assert.deepEqual(
    resolveNavGroupDisplayOrder({ explicitGroupOrder: ["cliproxy", "custom", "opencode"] }),
    ["cliproxy", "custom", "opencode"],
  );
});

test("resolveNavGroupDisplayOrder 忽略未知组 id 并去重，缺失组按 canonical 补齐", () => {
  assert.deepEqual(
    resolveNavGroupDisplayOrder({
      explicitGroupOrder: ["opencode", "bogus", "opencode", "custom"],
    }),
    ["opencode", "custom", "cliproxy"],
  );
});

test("reorderProviderIdsByNavGroups 按新组序整块搬移且组内相对顺序不变", () => {
  const providers = [
    makeProvider("go", "opencode-go"),
    makeProvider("meta", "opencode-meta"),
    makeProvider("codex", "cliproxy-codex"),
    makeProvider("deepseek", "deepseek"),
    makeProvider("cursor", "cursor"),
  ];
  const moved = reorderProviderIdsByNavGroups({
    providersInDisplayOrder: providers,
    groupOrder: ["cliproxy", "opencode", "custom"],
  });
  assert.deepEqual(moved, ["codex", "go", "meta", "deepseek", "cursor"]);
});

test("reorderProviderIdsByNavGroups 覆盖全部 provider，不丢条目", () => {
  const providers = [
    makeProvider("codex", "cliproxy-codex"),
    makeProvider("go", "opencode-go"),
    makeProvider("deepseek", "deepseek"),
  ];
  const moved = reorderProviderIdsByNavGroups({
    providersInDisplayOrder: providers,
    groupOrder: ["custom", "opencode", "cliproxy"],
  });
  assert.deepEqual([...moved].sort(), ["codex", "deepseek", "go"]);
});

test("拖组后的显式组序再次解析保持稳定（写入值即读回值）", () => {
  const dragged = ["custom", "cliproxy", "opencode"] as const;
  assert.deepEqual(resolveNavGroupDisplayOrder({ explicitGroupOrder: [...dragged] }), [...dragged]);
});
