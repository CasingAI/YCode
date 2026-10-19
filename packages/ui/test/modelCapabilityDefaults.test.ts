import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfigObject } from "@zcode/provider";
import { createProviderModelDraftValues } from "../src/settings/model-provider-section/ProviderModelMetadata.js";
import type { ProviderSettingsFormModel } from "../src/lib/providerSettingsFormTypes.js";

// 未识别模型的默认输入能力（docs/specs/model-capability-defaults.md）：
// 有效配置里没有 inputFormat 事实时，编辑器也按「文本 + 图片」给出初值，
// 避免界面显示成纯文本、而运行时按多模态发送这类前后不一致。

function buildModel(config: ModelConfigObject): ProviderSettingsFormModel {
  return {
    kind: "candidate",
    modelId: "acme-next-gen-preview",
    builtin: true,
    inheritedConfig: config,
    personalConfig: {},
    useRecommendedConfig: true,
    config,
    hasPersonalConfig: false,
    executable: true,
    selectable: true,
  };
}

test("有效配置没有输入能力事实时，编辑器默认勾选文本与图片", () => {
  const draft = createProviderModelDraftValues(
    buildModel({
      enabled: true,
      properties: {
        contextWindow: 200000,
        outputFormat: { supportsText: true },
        supportsToolCall: true,
      },
      optionSpecs: {
        reasoningLevel: { values: ["disabled", "low", "high"], map: "{}" },
        maxOutputTokens: { max: 32000 },
      },
    }),
  );

  assert.equal(draft.inputFormatValue.supportsText, true);
  assert.equal(draft.inputFormatValue.supportsImage, true);
  assert.equal(draft.inputFormatValue.supportsVideo, false);
  assert.equal(draft.inputFormatValue.supportsPdf, false);
});

test("有效配置显式声明纯文本时，编辑器不再默认勾选图片", () => {
  const draft = createProviderModelDraftValues(
    buildModel({
      enabled: true,
      properties: {
        contextWindow: 200000,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
      },
      optionSpecs: {
        reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
        maxOutputTokens: { max: 32000 },
      },
    }),
  );

  assert.equal(draft.inputFormatValue.supportsImage, false);
});
