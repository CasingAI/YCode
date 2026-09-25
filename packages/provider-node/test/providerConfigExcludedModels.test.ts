import assert from "node:assert/strict";
import test from "node:test";
import { decodeProviderConfigFile } from "../src/provider-config-file-codec.js";

function storedFile(providerRules: unknown[]) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

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
