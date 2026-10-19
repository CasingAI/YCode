import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ModelConfigRules,
  parseZCodeBuiltinModelConfigRules,
  resolveDefaultReasoningLevel,
} from "../src/index.js";

// 未识别模型的默认能力（docs/specs/model-capability-defaults.md）：
// 兜底规则必须给出「文本 + 图片」和「关闭 / 低 / 高」三档，且排在 modelRules 第一位，
// 不能压过任何已知模型的显式事实。

const BUILTIN_URL = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
const PROVIDER_ID = "personal:test-provider";

async function loadBuiltinRules(): Promise<ModelConfigRules> {
  const release = JSON.parse(await readFile(BUILTIN_URL, "utf8")) as {
    config: { modelConfigRules: unknown };
  };
  return parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
}

function resolveModel(
  rules: ModelConfigRules,
  modelId: string,
  options: { apiType?: string; baseUrl?: string } = {},
) {
  return rules.resolve({
    providerId: PROVIDER_ID,
    modelId,
    apiType: options.apiType ?? "openai-chat-completions",
    baseUrl: options.baseUrl ?? "https://gateway.example.com/v1",
  });
}

test("未识别模型默认支持文本与图片，推理档位为关闭/低/高", async () => {
  const rules = await loadBuiltinRules();
  const config = resolveModel(rules, "acme-next-gen-preview").toJSON();

  assert.equal(config.properties?.inputFormat?.supportsText, true);
  assert.equal(config.properties?.inputFormat?.supportsImage, true);
  // 视频与 PDF 仍属少数派能力，本次不翻转。
  assert.equal(config.properties?.inputFormat?.supportsVideo, false);
  assert.equal(config.properties?.inputFormat?.supportsPdf, false);

  assert.deepEqual(config.optionSpecs?.reasoningLevel?.values, ["disabled", "low", "high"]);
  // 档位表含 high 时默认 high（docs/specs/model-selection-default-level.md）。
  assert.equal(
    resolveDefaultReasoningLevel(config.optionSpecs?.reasoningLevel?.values ?? []),
    "high",
  );
});

test("兜底翻转不覆盖已知模型的显式能力", async () => {
  const rules = await loadBuiltinRules();

  // 显式声明纯文本的模型仍然是纯文本。
  const textOnly = resolveModel(rules, "glm-5-air").toJSON();
  assert.equal(textOnly.properties?.inputFormat?.supportsImage, false);

  // 显式声明多模态的模型仍然多模态。
  const multimodal = resolveModel(rules, "glm-4.6v").toJSON();
  assert.equal(multimodal.properties?.inputFormat?.supportsImage, true);
  assert.equal(multimodal.properties?.inputFormat?.supportsVideo, false);
});

test("gpt-6 家族的专属档位表不受兜底档位影响", async () => {
  const rules = await loadBuiltinRules();
  const config = resolveModel(rules, "gpt-6-sol").toJSON();

  assert.deepEqual(config.optionSpecs?.reasoningLevel?.values, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  // 该家族没有显式声明图片能力，因此落到兜底的「支持图片」。
  assert.equal(config.properties?.inputFormat?.supportsImage, true);
});
