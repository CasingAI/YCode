import assert from "node:assert/strict";
import test from "node:test";
import { buildRegistryModelSelectGroups } from "../src/lib/modelSelectionGroups.js";
import type { ModelSelectionView } from "@zcode/services";

// Primary 供应商配置（docs/specs/provider-primary.md）：
// 一级展开只看 isPrimary 标记，不再因账号套餐 access 自动展开；Primary 组置前。

function buildView(
  providers: Array<{
    providerId: string;
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

test("默认全关：账号套餐也不再自动一级展开", () => {
  const groups = buildRegistryModelSelectGroups(SELECTED, buildView([{ providerId: "p1" }]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directItems, undefined);
});

test("账号套餐 access 不再绑定展开，徽章逻辑不受影响", () => {
  const groups = buildRegistryModelSelectGroups(
    SELECTED,
    buildView([
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
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directItems, undefined);
  // 徽章展示保留：标题与 Individual 徽章仍按账号套餐口径呈现，只是不再自动展开。
  assert.equal(groups[0]?.labelBadge, "Individual");
});

test("勾选 Primary 后一级展开", () => {
  const groups = buildRegistryModelSelectGroups(
    SELECTED,
    buildView([{ providerId: "p1", isPrimary: true }]),
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.directItems, true);
});

test("Primary 组排在前面，非 Primary 保持原有相对顺序", () => {
  const groups = buildRegistryModelSelectGroups(
    SELECTED,
    buildView([
      { providerId: "ordinary-a" },
      { providerId: "primary-b", isPrimary: true },
      { providerId: "ordinary-c" },
    ]),
  );
  assert.deepEqual(
    groups.map((group) => group.key),
    ["registry-provider:primary-b", "registry-provider:ordinary-a", "registry-provider:ordinary-c"],
  );
});
