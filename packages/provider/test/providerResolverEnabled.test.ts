import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ZhipuAccountAccessConfig,
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
} from "../src/index.js";

const BUILTIN_URL = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
const PROVIDER_ID = "account:zai-individual-coding-plan";

async function loadInput(enabled?: boolean) {
  const release = JSON.parse(await readFile(BUILTIN_URL, "utf8")) as {
    config: {
      providerConfigRules: unknown;
      modelConfigRules: unknown;
    };
  };
  const builtin = parseZCodeBuiltinProviderConfigRules(release.config.providerConfigRules);
  const builtinModels = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
  const personalProviders =
    enabled === undefined
      ? ProviderConfigMap.empty()
      : new ProviderConfigMap([
          {
            providerId: PROVIDER_ID,
            enabled,
            config: new ProviderConfig(),
          },
        ]);
  const accountProviders = new ProviderConfigMap([
    [
      PROVIDER_ID,
      new ProviderConfig({
        access: new ZhipuAccountAccessConfig({ entitled: true }),
      }),
    ],
  ]);

  return {
    zcodeBuiltinProviders: builtin.providers,
    zcodeBuiltinProviderTemplates: builtin.providerTemplates,
    personalProviders,
    zcodeBuiltinModelRules: builtinModels,
    personalModels: ModelConfigRules.empty(),
    accountProviders,
    accountStates: {
      [PROVIDER_ID]: {
        availability: "available" as const,
        entitled: true,
        current: true,
      },
    },
  };
}

test("智谱账号 Provider 关闭后保留设置投影但不发布执行 Registry", async () => {
  const input = await loadInput(false);
  const resolution = new ProviderConfigResolver().resolve(input);
  const provider = resolution.resolvedProviders.find((item) => item.providerId === PROVIDER_ID);

  assert.ok(provider);
  assert.equal(provider.enabled, false);
  assert.equal(provider.config.access?.type, "zhipu-account");
  assert.ok(provider.models.length > 0);
  assert.equal(
    provider.models.every((model) => !model.executable),
    true,
  );
  assert.equal(
    provider.models.every((model) => !model.selectable),
    true,
  );
  assert.equal(
    resolution.registryProviders.some((item) => item.providerId === PROVIDER_ID),
    false,
  );
});

test("智谱账号 Provider 重新开启且账号条件有效时恢复发布", async () => {
  const input = await loadInput(true);
  const resolution = new ProviderConfigResolver().resolve(input);
  const provider = resolution.resolvedProviders.find((item) => item.providerId === PROVIDER_ID);
  const registryProvider = resolution.registryProviders.find(
    (item) => item.providerId === PROVIDER_ID,
  );

  assert.ok(provider);
  assert.equal(provider.enabled, true);
  assert.ok(registryProvider);
  assert.equal(
    provider.models.every((model) => model.executable),
    true,
  );
  assert.equal(
    provider.models.every((model) => model.selectable),
    true,
  );
});
