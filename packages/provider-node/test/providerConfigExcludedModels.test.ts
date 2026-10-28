import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../src/provider-config-file-codec.js";

function storedFile(providerRules: unknown[]) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

test("模型组成员选择策略经 codec 往返且保留重复条目", () => {
  const modelGroups = [
    {
      groupId: "model-group:schedule",
      name: "按时段选择",
      memberOrder: [
        { providerId: "p", modelId: "m", selectable: false },
        {
          providerId: "p",
          modelId: "m",
          selectable: true,
          deprioritizeSchedule: {
            timeZone: "America/Los_Angeles",
            windows: [{ daysOfWeek: [5, 6], startTime: "22:30", endTime: "02:00" }],
          },
        },
      ],
    },
  ];
  const decoded = decodeProviderConfigFile({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      modelGroups,
    },
  });

  assert.deepEqual(decoded.modelGroups, modelGroups);
  assert.deepEqual(encodeProviderConfigFile(decoded).config.modelGroups, modelGroups);
  assert.equal(encodeProviderConfigFile(decoded).schemaVersion, 1);
});

test("codec 在配置边界拒绝无效模型组时段", () => {
  assert.throws(() =>
    decodeProviderConfigFile({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        modelGroups: [
          {
            groupId: "model-group:invalid",
            name: "坏配置",
            memberOrder: [
              {
                providerId: "p",
                modelId: "m",
                deprioritizeSchedule: {
                  timeZone: "Not/AZone",
                  windows: [{ daysOfWeek: [1], startTime: "00:00", endTime: "24:00" }],
                },
              },
            ],
          },
        ],
      },
    }),
  );
});

test("旧模型组成员缺少选择策略字段时仍按原配置读取", () => {
  const decoded = decodeProviderConfigFile({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      modelGroups: [
        {
          groupId: "model-group:legacy",
          name: "旧组",
          memberOrder: [{ providerId: "p", modelId: "m" }],
        },
      ],
    },
  });
  assert.deepEqual(decoded.modelGroups?.[0]?.memberOrder, [{ providerId: "p", modelId: "m" }]);
});

test("旧字段 hiddenBuiltinModelIds 读取时迁移为 excludedModelIds", () => {
  const decoded = decodeProviderConfigFile(
    storedFile([
      {
        providerId: "provider-a",
        config: {
          group: "standard-personal",
          hiddenBuiltinModelIds: ["glm-5.3", "kimi-k3"],
        },
      },
    ]),
  );

  const provider = decoded.providers.get("provider-a");
  assert.deepEqual(provider?.excludedModelIds, ["glm-5.3", "kimi-k3"]);
  assert.equal("hiddenBuiltinModelIds" in (provider?.toJSON() ?? {}), false);
});

test("已经是新字段的配置原样读取", () => {
  const decoded = decodeProviderConfigFile(
    storedFile([
      {
        providerId: "provider-a",
        config: { group: "standard-personal", excludedModelIds: ["glm-5.3"] },
      },
    ]),
  );

  assert.deepEqual(decoded.providers.get("provider-a")?.excludedModelIds, ["glm-5.3"]);
});

test("providerGroupOrder additive 键读回与写回；未设置时键必须省略", () => {
  const withGroupOrder = decodeProviderConfigFile({
    schemaVersion: 1,
    config: {
      providerOrder: ["p2", "p1"],
      providerGroupOrder: ["cliproxy", "custom", "opencode"],
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  });
  assert.deepEqual(withGroupOrder.providerGroupOrder, ["cliproxy", "custom", "opencode"]);
  assert.deepEqual(encodeProviderConfigFile(withGroupOrder).config.providerGroupOrder, [
    "cliproxy",
    "custom",
    "opencode",
  ]);

  const withoutGroupOrder = decodeProviderConfigFile(storedFile([]));
  assert.equal(withoutGroupOrder.providerGroupOrder, undefined);
  assert.equal("providerGroupOrder" in encodeProviderConfigFile(withoutGroupOrder).config, false);
});
