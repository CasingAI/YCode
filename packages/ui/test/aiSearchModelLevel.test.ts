import assert from "node:assert/strict";
import test from "node:test";
import { resolveAiSearchModelSelection } from "../src/command-center/aiSearchModelLevel.js";

const catalog = {
  providers: [
    {
      providerId: "p1",
      models: [
        {
          modelId: "m-multi",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } } },
        },
        {
          modelId: "m-off",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "Off", "high"] } } },
        },
        {
          modelId: "m-single",
          config: { optionSpecs: { reasoningLevel: { values: ["high"] } } },
        },
        {
          modelId: "m-empty",
          config: { optionSpecs: { reasoningLevel: { values: [] } } },
        },
      ],
    },
  ],
};

test("多档位压到第一项", () => {
  const result = resolveAiSearchModelSelection(catalog, {
    providerId: "p1",
    modelId: "m-multi",
    options: { reasoningLevel: "high" },
  });
  assert.deepEqual(result, {
    providerId: "p1",
    modelId: "m-multi",
    options: { reasoningLevel: "low" },
  });
});

test("含关闭值时用关闭值并保留原大小写", () => {
  const result = resolveAiSearchModelSelection(catalog, {
    providerId: "p1",
    modelId: "m-off",
    options: { reasoningLevel: "high" },
  });
  assert.deepEqual(result, {
    providerId: "p1",
    modelId: "m-off",
    options: { reasoningLevel: "Off" },
  });
});

test("已是最低档时返回同一对象", () => {
  const selection = { providerId: "p1", modelId: "m-multi", options: { reasoningLevel: "low" } };
  assert.equal(resolveAiSearchModelSelection(catalog, selection), selection);
});

test("单档位/空档位/未知模型原样返回", () => {
  const single = { providerId: "p1", modelId: "m-single", options: { reasoningLevel: "high" } };
  assert.equal(resolveAiSearchModelSelection(catalog, single), single);
  const empty = { providerId: "p1", modelId: "m-empty", options: { reasoningLevel: "high" } };
  assert.equal(resolveAiSearchModelSelection(catalog, empty), empty);
  const unknown = { providerId: "p1", modelId: "m-gone", options: { reasoningLevel: "high" } };
  assert.equal(resolveAiSearchModelSelection(catalog, unknown), unknown);
  assert.equal(resolveAiSearchModelSelection(catalog, null), null);
});

test("无档位选择补上最低档", () => {
  const result = resolveAiSearchModelSelection(catalog, { providerId: "p1", modelId: "m-multi" });
  assert.deepEqual(result, {
    providerId: "p1",
    modelId: "m-multi",
    options: { reasoningLevel: "low" },
  });
});
