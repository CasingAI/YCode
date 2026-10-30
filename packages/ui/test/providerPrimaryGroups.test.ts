import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRegistryModelSelectGroups,
  withModelGroupSection,
} from "../src/lib/modelSelectionGroups.js";
import type { ProviderDisplayMode } from "@zcode/provider";
import type { ModelSelectionView } from "@zcode/services";

// 模型展示权重三态（docs/specs/provider-primary.md）：
// expanded 一级展开置前、submenu 普通二级菜单、other 收进末尾合成「其他」组；
// displayMode 优先，旧盘 isPrimary 由 resolveProviderDisplayMode 派生。

function buildView(
  providers: Array<{
    providerId: string;
    displayMode?: ProviderDisplayMode;
    /** 旧盘兼容字段：未写 displayMode 时按 isPrimary 派生。 */
    isPrimary?: boolean;
    access?: unknown;
    providerName?: string;
  }>,
): ModelSelectionView {
  return {
    revision: 1,
    providers: providers.map((provider) => ({
      providerId: provider.providerId,
      providerName: provider.providerName ?? null,
      templateId: undefined,
      ...(provider.displayMode === undefined ? {} : { displayMode: provider.displayMode }),
      ...(provider.isPrimary === undefined ? {} : { isPrimary: provider.isPrimary }),
      config: {
        api: { type: "anthropic-messages", baseUrl: "https://api.example.com" },
        ...(provider.access ? { access: provider.access } : {}),
      },
      models: [
        {
          modelId: "model-a",
          config: { properties: { inputFormat: {} } },
        },
      ],
    })),
  } as unknown as ModelSelectionView;
}

const SELECTED = "glm" as never;
const OTHER_LABEL = "其他";

function buildGroups(view: ModelSelectionView) {
  return buildRegistryModelSelectGroups(SELECTED, view, { otherGroupLabel: OTHER_LABEL });
}

test("displayMode=expanded 一级展开", () => {
  const groups = buildGroups(buildView([{ providerId: "p1", displayMode: "expanded" }]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directItems, true);
  assert.equal(groups[0]?.isOtherGroup, undefined);
});

test("displayMode=submenu 普通二级菜单组", () => {
  const groups = buildGroups(buildView([{ providerId: "p1", displayMode: "submenu" }]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directItems, undefined);
  assert.equal(groups[0]?.isOtherGroup, undefined);
});

test("旧盘 isPrimary=true 未写 displayMode 时派生为 expanded", () => {
  const groups = buildGroups(buildView([{ providerId: "p1", isPrimary: true }]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directItems, true);
});

test("旧盘未写任何标记时缺省 submenu（账号套餐也不再自动一级展开）", () => {
  const groups = buildGroups(
    buildView([
      { providerId: "p1" },
      {
        providerId: "account:zai-individual-coding-plan",
        access: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "individual-coding-plan",
          entitled: true,
        },
      },
    ]),
  );
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.equal(group.directItems, undefined);
    // 智谱旧账号体系已下线，残留的历史 access 不应复活套餐徽章。
    assert.equal(group.labelBadge, undefined);
  }
});

test("expanded 组置前、submenu 沿用供应商序", () => {
  const groups = buildGroups(
    buildView([
      { providerId: "submenu-a", displayMode: "submenu" },
      { providerId: "expanded-b", displayMode: "expanded" },
      { providerId: "submenu-c", displayMode: "submenu" },
    ]),
  );
  assert.deepEqual(
    groups.map((group) => group.key),
    ["registry-provider:expanded-b", "registry-provider:submenu-a", "registry-provider:submenu-c"],
  );
});

test("other 供应商收进合成「其他」组：平铺全集 + 按供应商分段", () => {
  const view = buildView([
    { providerId: "other-a", displayMode: "other" },
    { providerId: "other-b", displayMode: "other" },
  ]);
  const groups = buildGroups(view);
  assert.equal(groups.length, 1);
  const otherGroup = groups[0];
  assert.ok(otherGroup);
  assert.equal(otherGroup.key, "model-selection-other");
  assert.equal(otherGroup.label, OTHER_LABEL);
  assert.equal(otherGroup.isOtherGroup, true);
  // 不再为 other 供应商产出独立顶层组；平铺 items 是两个供应商模型的全集。
  assert.deepEqual(
    otherGroup.items.map((item) => item.key),
    ["registry-provider:other-a:model-a", "registry-provider:other-b:model-a"],
  );
  // 分段 key 沿用 registry-provider:<id>，label 为供应商名，items 与平铺引用同一批对象。
  assert.deepEqual(
    otherGroup.subSections?.map((subSection) => subSection.key),
    ["registry-provider:other-a", "registry-provider:other-b"],
  );
  assert.equal(otherGroup.subSections?.[0]?.label, "other-a");
  assert.ok(otherGroup.subSections?.[0]?.items[0] === otherGroup.items[0]);
  assert.ok(otherGroup.subSections?.[1]?.items[0] === otherGroup.items[1]);
});

test("混合三态排序：expanded → submenu → 合成「其他」组", () => {
  const groups = buildGroups(
    buildView([
      { providerId: "other-z", displayMode: "other" },
      { providerId: "submenu-m", displayMode: "submenu" },
      { providerId: "expanded-a", displayMode: "expanded" },
      { providerId: "other-b", displayMode: "other" },
    ]),
  );
  // 结构快照：key / directItems / isOtherGroup / 平铺 items 数。
  assert.deepEqual(
    groups.map((group) => ({
      key: group.key,
      directItems: group.directItems === true,
      isOtherGroup: group.isOtherGroup === true,
      itemCount: group.items.length,
    })),
    [
      { key: "registry-provider:expanded-a", directItems: true, isOtherGroup: false, itemCount: 1 },
      { key: "registry-provider:submenu-m", directItems: false, isOtherGroup: false, itemCount: 1 },
      { key: "model-selection-other", directItems: false, isOtherGroup: true, itemCount: 2 },
    ],
  );
});

test("存在 other 供应商时缺 otherGroupLabel 直接抛错，不做硬编码回退", () => {
  assert.throws(
    () =>
      buildRegistryModelSelectGroups(
        SELECTED,
        buildView([{ providerId: "p1", displayMode: "other" }]),
      ),
    /otherGroupLabel/,
  );
});

test("withModelGroupSection：「模型组」分节插在「其他」组之前", () => {
  const registryGroups = buildGroups(
    buildView([
      { providerId: "submenu-m", displayMode: "submenu" },
      { providerId: "other-z", displayMode: "other" },
    ]),
  );
  const merged = withModelGroupSection({
    registryGroups,
    view: {
      modelGroups: [{ groupId: "g1", name: "G1", members: [] }],
      modelGroupsPrimary: false,
    },
    groupSectionLabel: "模型组",
  });
  assert.deepEqual(
    merged.map((group) => group.key),
    ["registry-provider:submenu-m", "model-groups", "model-selection-other"],
  );
});

test("withModelGroupSection：sectionPrimary=true 时整节仍置顶（「其他」组随 registry 排后）", () => {
  const registryGroups = buildGroups(
    buildView([
      { providerId: "submenu-m", displayMode: "submenu" },
      { providerId: "other-z", displayMode: "other" },
    ]),
  );
  const merged = withModelGroupSection({
    registryGroups,
    view: {
      modelGroups: [{ groupId: "g1", name: "G1", members: [] }],
      modelGroupsPrimary: false,
    },
    groupSectionLabel: "模型组",
    sectionPrimary: true,
  });
  assert.deepEqual(
    merged.map((group) => group.key),
    ["model-groups", "registry-provider:submenu-m", "model-selection-other"],
  );
  assert.equal(merged[0]?.directItems, true);
});
