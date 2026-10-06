import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsFormProvider } from "../src/lib/providerSettingsFormTypes.js";
import { persistPersonalProvider } from "../src/lib/providerPersonalSave.js";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";

// Primary 开关只提交 isPrimary 稀疏补丁：未触碰时不把继承标记物化进个人配置。

function buildProvider(
  overrides: Partial<ProviderSettingsFormProvider> = {},
): ProviderSettingsFormProvider {
  return {
    providerId: "p1",
    providerName: "P1",
    templateId: undefined,
    enabled: true,
    isPrimary: false,
    executable: true,
    hasPersonalConfig: false,
    personalConfig: {},
    config: {},
    models: [],
    ...overrides,
  };
}

function stubService() {
  const calls: Array<Parameters<IProviderSettingsService["savePersonalProviderOverlay"]>> = [];
  const service: Pick<IProviderSettingsService, "savePersonalProviderOverlay"> = {
    savePersonalProviderOverlay: async (...args) => {
      calls.push(args);
      return {} as ProviderSettingsView;
    },
  };
  return { calls, service };
}

test("Primary 开关切换只提交 isPrimary，不夹带 enabled", async () => {
  const { calls, service } = stubService();
  await persistPersonalProvider({
    provider: buildProvider({ isPrimaryUpdate: true }),
    providerSettingsService: service,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.[2], { isPrimary: true });
});

test("未触碰 Primary 时不提交 metadata，避免物化继承标记", async () => {
  const { calls, service } = stubService();
  await persistPersonalProvider({
    provider: buildProvider(),
    providerSettingsService: service,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[2], undefined);
});
