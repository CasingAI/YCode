import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { ModelSelectGroup } from "../src/ModelConfigSelect.js";
import { encodeCustomModelValue } from "../src/lib/zcodeCustomModelValue.js";
import { resolveV4ModelTriggerDisplay } from "../src/v4/composer/modelTriggerDisplay.js";

// 输入区胶囊的标签解析（docs/specs/composer-model-display-name.md）：
// 展示名只在触发器上做格式化，选择值（下拉项 value / 回传 runtime 的 model id）保持原始 id。

const BUILTIN_PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
const CUSTOM_PROVIDER_ID = "opencode-go-chat";

function buildGroups(providerId: string, modelIds: readonly string[]): ModelSelectGroup[] {
  return [
    {
      key: `registry-provider:${providerId}`,
      label: providerId,
      items: modelIds.map((modelId) => ({
        key: `registry-provider:${providerId}:${modelId}`,
        value: encodeCustomModelValue(providerId, modelId),
        name: modelId,
      })),
    },
  ];
}

function resolveTrigger(modelId: string, options?: { providerId?: string; providerName?: string }) {
  const providerId = options?.providerId ?? BUILTIN_PROVIDER_ID;
  const modelGroups = buildGroups(providerId, [modelId]);
  return resolveV4ModelTriggerDisplay({
    modelGroups,
    normalizedValue: encodeCustomModelValue(providerId, modelId),
    fallbackLabel: "选择模型",
    providerId,
    providerName: options?.providerName,
  });
}

test("内置家族：胶囊只显示格式化后的模型名，不拼 provider 前缀", () => {
  const display = resolveTrigger("deepseek-v4.1-flash");
  assert.equal(display.modelLabel, "Deepseek V4.1 Flash");
  assert.equal(display.fullLabel, "Deepseek V4.1 Flash");
  assert.equal(display.providerPrefix, undefined);
});

test("其它 provider：前缀行为不变，模型段用展示名", () => {
  const display = resolveTrigger("claude-opus-4-5", {
    providerId: CUSTOM_PROVIDER_ID,
    providerName: "OpenCode Go",
  });
  assert.equal(display.providerPrefix, "OpenCode Go/");
  assert.equal(display.modelLabel, "Claude Opus 4.5");
  assert.equal(display.fullLabel, "OpenCode Go/Claude Opus 4.5");
});

test("provider 名称为空时仍然不拼前缀", () => {
  const display = resolveTrigger("glm-5.3-flash", {
    providerId: CUSTOM_PROVIDER_ID,
    providerName: "   ",
  });
  assert.equal(display.modelLabel, "GLM 5.3 Flash");
  assert.equal(display.fullLabel, "GLM 5.3 Flash");
});

test("目录里没有的模型回落占位，占位文案不经格式化", () => {
  // 占位串刻意带分隔符：若实现误把 fallback 送进格式化函数，断言会立刻失败。
  const fallbackLabel = "已下线_模型";
  const display = resolveV4ModelTriggerDisplay({
    modelGroups: buildGroups(BUILTIN_PROVIDER_ID, ["glm-5.3"]),
    normalizedValue: encodeCustomModelValue(BUILTIN_PROVIDER_ID, "已下线_模型"),
    fallbackLabel,
    providerId: BUILTIN_PROVIDER_ID,
    providerName: undefined,
  });
  assert.equal(display.modelLabel, fallbackLabel);
  assert.equal(display.fullLabel, fallbackLabel);
});
