import assert from "node:assert/strict";
import test from "node:test";
import { persistPersonalProvider } from "../src/lib/providerPersonalSave.js";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import type { ProviderSettingsFormProvider } from "../src/lib/providerSettingsFormTypes.js";

// 上游代理模式保存（docs/specs/plugin-cli-proxy-binary.md「上游代理」）：
// 只有本次显式修改（proxyModeUpdate）才进 metadata；未触碰不物化。

function provider(): ProviderSettingsFormProvider {
  return {
    providerId: "cliproxy-codex",
    templateId: "cliproxy-codex",
    providerName: "Codex",
    enabled: true,
    executable: true,
    isPrimary: false,
    proxyMode: "default",
    config: { group: "standard-personal" },
    personalConfig: { group: "standard-personal" },
    models: [],
  } as unknown as ProviderSettingsFormProvider;
}

function service(calls: unknown[]): Pick<IProviderSettingsService, "savePersonalProviderOverlay"> {
  return {
    savePersonalProviderOverlay: (async (...args: unknown[]) => {
      calls.push(args);
      return {} as ProviderSettingsView;
    }) as IProviderSettingsService["savePersonalProviderOverlay"],
  };
}

test("显式切换上游代理：metadata 带 proxyMode", async () => {
  const calls: unknown[] = [];
  await persistPersonalProvider({
    provider: { ...provider(), proxyModeUpdate: "proxy" },
    providerSettingsService: service(calls),
  });
  const metadata = (calls[0] as unknown[])[2] as { proxyMode?: string };
  assert.equal(metadata.proxyMode, "proxy");
});

test("未触碰上游代理：不物化 proxyMode（含切回 default 也显式写入）", async () => {
  const calls: unknown[] = [];
  await persistPersonalProvider({
    provider: provider(),
    providerSettingsService: service(calls),
  });
  assert.equal((calls[0] as unknown[])[2], undefined);

  await persistPersonalProvider({
    provider: { ...provider(), proxyModeUpdate: "default" },
    providerSettingsService: service(calls),
  });
  const metadata = (calls[1] as unknown[])[2] as { proxyMode?: string };
  assert.equal(metadata.proxyMode, "default");
});
