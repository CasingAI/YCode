import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsView } from "@zcode/services";
import {
  resolveAccountProviderInspectionAccess,
  resolveAccountProviderInspectionFingerprint,
  resolveEntitledAccountProviderAccessFingerprint,
} from "../src/lib/accountProviderAccess.js";

const PROVIDER_ID = "account:zai-individual-coding-plan";

function createView(
  revision: number,
  options: {
    mode?: "individual-coding-plan" | "start-plan";
    current?: boolean;
    enabled?: boolean;
  } = {},
): ProviderSettingsView {
  const mode = options.mode ?? "individual-coding-plan";
  return {
    revision,
    providerTemplates: [],
    providerOrder: [PROVIDER_ID],
    providers: [
      {
        providerId: PROVIDER_ID,
        enabled: options.enabled ?? true,
        executable: options.enabled ?? true,
        effectiveConfig: {
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode,
            entitled: true,
          },
          api: { type: "anthropic-messages", baseUrl: "https://api.z.ai/api/anthropic" },
        },
        personalConfig: {},
        config: {},
        issues: [],
        models: [],
        accountState: {
          availability: "available",
          entitled: true,
          current: options.current ?? true,
          connectionKey: "connection-1",
        },
      },
    ],
  } as ProviderSettingsView;
}

test("账号权益 fingerprint 不随 Provider Settings revision 变化", () => {
  const first = createView(1);
  const second = createView(2);

  assert.equal(
    resolveEntitledAccountProviderAccessFingerprint(first, PROVIDER_ID),
    resolveEntitledAccountProviderAccessFingerprint(second, PROVIDER_ID),
  );
  assert.equal(
    resolveAccountProviderInspectionFingerprint(first, PROVIDER_ID),
    resolveAccountProviderInspectionFingerprint(second, PROVIDER_ID),
  );
});

test("Provider 开关不改变账号事实 fingerprint", () => {
  const enabled = createView(3);
  const disabled = createView(3, { enabled: false });
  // 关闭只阻断模型执行：账号套餐身份必须保持同一个指纹，否则消费方会当成套餐变了。
  assert.equal(
    resolveAccountProviderInspectionFingerprint(enabled, PROVIDER_ID),
    resolveAccountProviderInspectionFingerprint(disabled, PROVIDER_ID),
  );
  assert.equal(
    resolveEntitledAccountProviderAccessFingerprint(enabled, PROVIDER_ID),
    resolveEntitledAccountProviderAccessFingerprint(disabled, PROVIDER_ID),
  );
  // 只读额度/购买入口仍认被关闭的套餐，不因 enabled 变成"没有套餐"。
  assert.ok(resolveAccountProviderInspectionAccess(disabled, PROVIDER_ID));
});

test("账号 access 或 connection facts 变化会改变权益 fingerprint", () => {
  const base = createView(1);
  const accessChanged = createView(2, { mode: "start-plan" });
  const connectionChanged = createView(2, { current: false });

  assert.notEqual(
    resolveAccountProviderInspectionFingerprint(base, PROVIDER_ID),
    resolveAccountProviderInspectionFingerprint(accessChanged, PROVIDER_ID),
  );
  assert.notEqual(
    resolveAccountProviderInspectionFingerprint(base, PROVIDER_ID),
    resolveAccountProviderInspectionFingerprint(connectionChanged, PROVIDER_ID),
  );
});
