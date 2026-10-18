import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  ModelConfigRules,
  ProviderConfigResolver,
  createRegistryProviderConfig,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
  serializeRegistryProviderConfig,
  type ProviderConfigLayerSnapshot,
} from "../src/index.js";
import type { ChatGPTPlanState } from "@zcode/shared/chatgpt-plan";

test("ChatGPT access 严格隔离 API Key；普通 OpenAI 序列化保持原样", () => {
  assert.throws(() =>
    parseProviderConfig({
      access: { type: "chatgpt-plan", accountId: "a", apiKey: "must-not-be-accepted" },
    }),
  );
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "test-key" },
      api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
    }),
  );
  assert.ok(provider.ok);
  assert.deepEqual(serializeRegistryProviderConfig(provider.config).access, {
    type: "api-key",
    apiKey: "test-key",
  });
});

test("账户目录原子发布到现有 Registry；退出移除可用模型且保留其他 provider、模型组与默认选择", async () => {
  const release = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  const builtins = parseZCodeBuiltinProviderConfigRules(release.config.providerConfigRules);
  const builtin: ProviderConfigLayerSnapshot = {
    revision: "builtin",
    providers: builtins.providers,
    providerTemplates: builtins.providerTemplates,
    models: parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules),
    discoveredModelRules: ModelConfigRules.empty(),
  };
  const original = new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ apiKey: "test-api-key" }),
    api: new ProviderApiConfig({
      type: "openai-chat-completions",
      baseUrl: "https://api.openai.com/v1",
    }),
    personalModelIds: ["gpt-5.4"],
  });
  let personal: ProviderConfigLayerSnapshot = {
    revision: "p0",
    providers: new ProviderConfigMap([["openai-key-test", original]]),
    models: ModelConfigRules.empty(),
    discoveredModelRules: ModelConfigRules.empty(),
    defaultModelSelection: {
      providerId: "openai-key-test",
      modelId: "gpt-5.4",
      options: { reasoningLevel: "high" },
    },
    modelGroups: [{ groupId: "model-group:test", name: "Test group", memberOrder: [] }],
  };
  let updates = 0;
  const service = new ProviderConfigService({
    zcodeBuiltinSource: { read: async () => builtin, onDidChange: () => () => {} },
    personalRepository: {
      read: async () => personal,
      onDidChange: () => () => {},
      async update(change) {
        updates += 1;
        personal = { ...personal, ...change(personal), revision: `p${updates}` };
        return personal;
      },
    },
  });
  const state: ChatGPTPlanState = {
    available: true,
    pending: false,
    activeAccountId: "account-a",
    accounts: [{ id: "account-a", label: "Test", connected: true, sharing: true }],
    models: [{ slug: "gpt-5.4", displayName: "GPT" }],
  };
  await service.publishChatGPTPlanProvider(state);
  assert.equal(updates, 1);
  await service.publishChatGPTPlanProvider(state);
  assert.equal(updates, 1);
  const snapshot = await service.read();
  const resolution = new ProviderConfigResolver().resolve({
    ...snapshot,
    chatGPTPlanAvailable: true,
    accountProviders: ProviderConfigMap.empty(),
  });
  const unsupported = new ProviderConfigResolver().resolve({
    ...snapshot,
    accountProviders: ProviderConfigMap.empty(),
  });
  assert.equal(
    unsupported.registryProviders.some((p) => p.providerId === "openai-chatgpt-plan"),
    false,
  );
  const plan = resolution.registryProviders.find(
    (provider) => provider.providerId === "openai-chatgpt-plan",
  );
  assert.equal(plan?.config.access.type, "chatgpt-plan");
  assert.equal(plan?.models[0]?.modelId, "gpt-5.4");
  assert.deepEqual(personal.providers.get("openai-key-test")?.toJSON(), original.toJSON());
  assert.equal(personal.defaultModelSelection?.providerId, "openai-key-test");
  assert.equal(personal.modelGroups?.length, 1);
  await service.publishChatGPTPlanProvider({
    ...state,
    accounts: [{ ...state.accounts[0]!, connected: false, sharing: false }],
    models: [],
  });
  assert.deepEqual(personal.providers.get("openai-chatgpt-plan")?.personalModelIds, []);
  service.dispose();
});
