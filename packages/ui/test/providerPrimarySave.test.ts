import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsFormProvider } from "../src/lib/providerSettingsFormTypes.js";
import { persistPersonalProvider } from "../src/lib/providerPersonalSave.js";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";

// 模型展示权重保存（docs/specs/provider-primary.md）：显式修改只提交 displayMode
// 稀疏补丁；未触碰时不把继承层级物化进个人配置。

function buildProvider(
  overrides: Partial<ProviderSettingsFormProvider> = {},
): ProviderSettingsFormProvider {
  return {
    providerId: "p1",
    providerName: "P1",
    templateId: undefined,
    enabled: true,
    displayMode: "submenu",
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

test("展示权重切换只提交 displayMode，不夹带 enabled", async () => {
  const { calls, service } = stubService();
  await persistPersonalProvider({
    provider: buildProvider({ displayModeUpdate: "expanded" }),
    providerSettingsService: service,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.[2], { displayMode: "expanded" });
});

test("展示权重切回 submenu 也是显式写入，不下发 metadata 之外的键", async () => {
  const { calls, service } = stubService();
  await persistPersonalProvider({
    provider: buildProvider({ displayModeUpdate: "other" }),
    providerSettingsService: service,
  });
  assert.deepEqual(calls[0]?.[2], { displayMode: "other" });
});

test("未触碰展示权重时不提交 metadata，避免物化继承层级", async () => {
  const { calls, service } = stubService();
  await persistPersonalProvider({
    provider: buildProvider(),
    providerSettingsService: service,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[2], undefined);
});
