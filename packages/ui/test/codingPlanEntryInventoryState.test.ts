import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { resolveCodingPlanEntryInventoryStatus } from "../src/lib/codingPlanEntryInventoryState.js";
import { buildOffPeakEligibilityFreshnessKey } from "../src/lib/offPeakEligibilityFreshnessKey.js";

const ZAI_PLAN_PROVIDER_ID = "account:zai-individual-coding-plan";
const USER = { id: "user-1" };

/** 只保留指纹与入口状态决策关心的字段：enabled、access、accountState。 */
function createView(revision: number, options: { enabled?: boolean; current?: boolean } = {}) {
  return {
    revision,
    providerTemplates: [],
    providerOrder: [ZAI_PLAN_PROVIDER_ID],
    providers: [
      {
        providerId: ZAI_PLAN_PROVIDER_ID,
        enabled: options.enabled ?? true,
        executable: options.enabled ?? true,
        effectiveConfig: {
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "individual-coding-plan",
            entitled: true,
          },
        },
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
  } as unknown as ProviderSettingsView;
}

function createSettings(): AppSettings {
  return {
    providerFamilyDomain: "zai",
    providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
  } as unknown as AppSettings;
}

test("Provider 开关后购买入口保持 ready，不进入正在查询", () => {
  const ready = {
    cached: { user: USER, generation: 0, identity: "ready:fp" },
    entitlementLoading: false,
    generation: 0,
    identity: "ready:fp",
    missingCount: 0,
    settingsFailed: false,
    settingsLoading: false,
    teamsResolved: true,
    user: USER,
  } as const;

  assert.equal(resolveCodingPlanEntryInventoryStatus(ready), "ready");
  // identity 只由账号事实决定：设置投影换新对象（revision +1 / enabled 翻转）不影响结果身份。
  assert.equal(
    resolveCodingPlanEntryInventoryStatus({
      ...ready,
      cached: { ...ready.cached, user: ready.user },
    }),
    "ready",
  );
});

test("套餐身份变化、未就绪或权益缺失时购买入口进入 loading/error", () => {
  const base = {
    cached: { user: USER, generation: 0, identity: "ready:fp" },
    entitlementLoading: false,
    generation: 0,
    identity: "ready:fp",
    missingCount: 0,
    settingsFailed: false,
    settingsLoading: false,
    teamsResolved: true,
    user: USER,
  } as const;

  assert.equal(
    resolveCodingPlanEntryInventoryStatus({ ...base, identity: "ready:fp-2" }),
    "loading",
    "账号事实变化后必须重新查询",
  );
  assert.equal(resolveCodingPlanEntryInventoryStatus({ ...base, generation: 1 }), "loading");
  assert.equal(
    resolveCodingPlanEntryInventoryStatus({ ...base, settingsLoading: true }),
    "loading",
  );
  assert.equal(
    resolveCodingPlanEntryInventoryStatus({ ...base, cached: null }),
    "loading",
    "首次查询未完成前保持 loading",
  );
  assert.equal(
    resolveCodingPlanEntryInventoryStatus({ ...base, entitlementLoading: true }),
    "loading",
  );
  assert.equal(resolveCodingPlanEntryInventoryStatus({ ...base, missingCount: 1 }), "error");
  assert.equal(resolveCodingPlanEntryInventoryStatus({ ...base, teamsResolved: false }), "error");
  assert.equal(
    resolveCodingPlanEntryInventoryStatus({ ...base, settingsFailed: true }),
    "error",
    "设置加载失败优先于 loading",
  );
});

test("闲时套餐资格键不随 Provider 开关变化，账号事实变化会改键", () => {
  const settings = createSettings();
  const enabled = createView(1);
  const disabled = createView(2, { enabled: false });
  const notCurrent = createView(2, { current: false });
  const switched = createSettings();
  (
    switched as { providerFamilyConnectionSelections: Record<string, unknown> }
  ).providerFamilyConnectionSelections = { zai: { kind: "team-coding-plan" } };

  const base = buildOffPeakEligibilityFreshnessKey({
    providerSettingsView: enabled,
    settings,
  });
  assert.ok(base);
  assert.equal(
    buildOffPeakEligibilityFreshnessKey({ providerSettingsView: disabled, settings }),
    base,
    "关闭 Provider 不改变闲时套餐资格",
  );
  assert.notEqual(
    buildOffPeakEligibilityFreshnessKey({ providerSettingsView: notCurrent, settings }),
    base,
    "当前连接失效必须重查资格",
  );
  assert.notEqual(
    buildOffPeakEligibilityFreshnessKey({ providerSettingsView: enabled, settings: switched }),
    base,
    "切到别的套餐模式必须重查资格",
  );
  assert.equal(
    buildOffPeakEligibilityFreshnessKey({ providerSettingsView: null, settings }),
    undefined,
    "设置未就绪时不查询",
  );
  assert.equal(
    buildOffPeakEligibilityFreshnessKey({ providerSettingsView: enabled, settings: null }),
    undefined,
  );
});
