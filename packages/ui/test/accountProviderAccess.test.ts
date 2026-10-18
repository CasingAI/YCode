import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsView } from "@zcode/services";
import {
  resolveAccountProviderInspectionAccess,
  resolveAccountProviderInspectionFingerprint,
  resolveEntitledAccountProviderAccess,
  resolveEntitledAccountProviderAccessFingerprint,
} from "../src/lib/accountProviderAccess.js";

const LEGACY_PROVIDER_ID = "account:zai-individual-coding-plan";

function createLegacyView(
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
    providerOrder: [LEGACY_PROVIDER_ID],
    providers: [
      {
        providerId: LEGACY_PROVIDER_ID,
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

// docs/specs/zhipu-special-removal.md: 账号权益已下线，以下函数仅作兼容入口。
// 旧账号记录即使残留也不能使 UI 重新暴露套餐查询、连接状态或身份指纹。
test("旧智谱套餐数据不再生成权益身份和只读查询入口", () => {
  const legacyView = createLegacyView(1);
  assert.equal(resolveEntitledAccountProviderAccess(legacyView, LEGACY_PROVIDER_ID), null);
  assert.equal(resolveAccountProviderInspectionAccess(legacyView, LEGACY_PROVIDER_ID), null);
  assert.equal(resolveAccountProviderInspectionFingerprint(legacyView, LEGACY_PROVIDER_ID), "");
  assert.equal(resolveEntitledAccountProviderAccessFingerprint(legacyView, LEGACY_PROVIDER_ID), "");
});

test("Provider 启停和 revision 不会复活旧套餐事实", () => {
  for (const view of [createLegacyView(1), createLegacyView(2, { enabled: false })]) {
    assert.equal(resolveEntitledAccountProviderAccess(view, LEGACY_PROVIDER_ID), null);
    assert.equal(resolveAccountProviderInspectionAccess(view, LEGACY_PROVIDER_ID), null);
    assert.equal(resolveAccountProviderInspectionFingerprint(view, LEGACY_PROVIDER_ID), "");
    assert.equal(resolveEntitledAccountProviderAccessFingerprint(view, LEGACY_PROVIDER_ID), "");
  }
});

test("旧套餐 mode 与 connection facts 变化仍不会产生权益指纹", () => {
  for (const view of [
    createLegacyView(1, { mode: "start-plan" }),
    createLegacyView(2, { current: false }),
  ]) {
    assert.equal(resolveAccountProviderInspectionFingerprint(view, LEGACY_PROVIDER_ID), "");
    assert.equal(resolveEntitledAccountProviderAccessFingerprint(view, LEGACY_PROVIDER_ID), "");
    assert.equal(resolveAccountProviderInspectionAccess(view, LEGACY_PROVIDER_ID), null);
  }
  assert.equal(resolveAccountProviderInspectionAccess(null, LEGACY_PROVIDER_ID), null);
});
