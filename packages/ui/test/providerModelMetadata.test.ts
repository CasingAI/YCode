import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfigObject } from "@zcode/provider";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "../src/settings/model-provider-section/ProviderModelMetadata.js";
import type { ProviderSettingsFormModel } from "../src/lib/providerSettingsFormTypes.js";

// 按模型代理模式（proxyMode）在编辑弹窗里的三态稀疏提交（docs/specs/network-settings.md）：
// 未触碰不写 Overlay；改动与继承相同则删、不同则写；"default" 是显式三态，能压过继承的 proxy/direct；
// 推荐/手动模式切换不丢失该用户偏好。

const REASONING_MAP = '{"thinking":"enabled"}';

function buildModel({
  inherited,
  personal,
  configProxyMode,
  useRecommendedConfig = true,
}: {
  inherited?: ModelConfigObject;
  personal?: ModelConfigObject;
  configProxyMode?: ModelConfigObject["proxyMode"];
  useRecommendedConfig?: boolean;
} = {}): ProviderSettingsFormModel {
  // 继承基线始终携带完整可校验的 properties/optionSpecs；用例只覆盖其 proxyMode。
  const fullInherited: ModelConfigObject = {
    enabled: true,
    properties: {
      contextWindow: 128000,
      inputFormat: { supportsText: true },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
    },
    optionSpecs: {
      reasoningLevel: { values: ["off"], map: REASONING_MAP },
      maxOutputTokens: { max: 8192 },
    },
    ...(inherited ?? {}),
  };
  const config: ModelConfigObject = {
    ...fullInherited,
    ...(configProxyMode === undefined ? {} : { proxyMode: configProxyMode }),
  };
  return {
    kind: "candidate",
    modelId: "test-model",
    builtin: true,
    inheritedConfig: fullInherited,
    personalConfig: personal ?? {},
    useRecommendedConfig,
    config,
    hasPersonalConfig: Object.keys(personal ?? {}).length > 0,
    executable: true,
    selectable: true,
  };
}

function commit(
  model: ProviderSettingsFormModel,
  proxyModeValue?: string,
  extraDraft?: Partial<{
    contextWindowValue: string;
    maxOutputTokensValue: string;
    reasoningLevelMapValue: string;
  }>,
) {
  const draft = createProviderModelDraftValues(model);
  if (proxyModeValue !== undefined) {
    draft.proxyModeValue = proxyModeValue as typeof draft.proxyModeValue;
  }
  Object.assign(draft, extraDraft);
  const result = resolveProviderModelDraftCommit({ currentModel: model, draft });
  assert.equal(result.status, "commit");
  return result.status === "commit" ? result.model : null;
}

test("默认「未指定」且无继承值：不写 personal 叶子，行为与没有该字段时一致", () => {
  const model = buildModel();
  assert.equal(createProviderModelDraftValues(model).proxyModeValue, "default");
  const committed = commit(model);
  assert.equal(committed?.personalConfig.proxyMode, undefined);
  assert.equal(committed?.config.proxyMode, "default");
});

test("无继承值时选「使用代理」：物化 personal.proxyMode = proxy", () => {
  const committed = commit(buildModel(), "proxy");
  assert.equal(committed?.personalConfig.proxyMode, "proxy");
  assert.equal(committed?.config.proxyMode, "proxy");
});

test("无继承值时选「系统代理设置」：物化 personal.proxyMode = system", () => {
  const committed = commit(buildModel(), "system");
  assert.equal(committed?.personalConfig.proxyMode, "system");
  assert.equal(committed?.config.proxyMode, "system");
});

test("继承 proxy 且未改动：不写 personal 叶子", () => {
  const model = buildModel({ inherited: { proxyMode: "proxy" }, configProxyMode: "proxy" });
  const committed = commit(model);
  assert.equal(committed?.personalConfig.proxyMode, undefined);
});

test("继承 proxy 改为 direct / 显式未指定：分别物化 direct 与 default 压过继承", () => {
  const inherited = { proxyMode: "proxy" } as ModelConfigObject;
  const toDirect = commit(buildModel({ inherited, configProxyMode: "proxy" }), "direct");
  assert.equal(toDirect?.personalConfig.proxyMode, "direct");
  const toSystem = commit(buildModel({ inherited, configProxyMode: "proxy" }), "system");
  assert.equal(toSystem?.personalConfig.proxyMode, "system");
  const toDefault = commit(buildModel({ inherited, configProxyMode: "proxy" }), "default");
  assert.equal(toDefault?.personalConfig.proxyMode, "default");
});

test("继承 proxy 改回与继承相同的 proxy：删除 personal 叶子", () => {
  const inherited = { proxyMode: "proxy" } as ModelConfigObject;
  const personal = { proxyMode: "direct" } as ModelConfigObject;
  const model = buildModel({ inherited, personal, configProxyMode: "direct" });
  assert.equal(createProviderModelDraftValues(model).proxyModeValue, "direct");
  const committed = commit(model, "proxy");
  assert.equal(committed?.personalConfig.proxyMode, undefined);
});

test("已有 personal 值且未改动：原样保留稀疏 Overlay", () => {
  const personal = { proxyMode: "direct" } as ModelConfigObject;
  const model = buildModel({ personal, configProxyMode: "direct" });
  const committed = commit(model);
  assert.equal(committed?.personalConfig.proxyMode, "direct");
});

test("切回推荐配置（清空手动配置）：proxyMode 作为用户偏好保留", () => {
  const personal = { proxyMode: "direct" } as ModelConfigObject;
  const model = buildModel({ personal, configProxyMode: "direct" });
  const draft = createProviderModelDraftValues(model);
  draft.clearPersonalConfigValue = true;
  const result = resolveProviderModelDraftCommit({ currentModel: model, draft });
  assert.equal(result.status, "commit");
  if (result.status === "commit") {
    assert.equal(result.model.personalConfig.proxyMode, "direct");
  }
});

test("手动模式（不跟随推荐）下选择 proxyMode：写入 personal", () => {
  // 手动模式下继承基线不可见，上下文窗口/最大输出/推理映射都必须显式输入。
  const committed = commit(buildModel({ useRecommendedConfig: false }), "proxy", {
    contextWindowValue: "128000",
    maxOutputTokensValue: "8192",
    reasoningLevelMapValue: REASONING_MAP,
  });
  assert.equal(committed?.personalConfig.proxyMode, "proxy");
});
