import assert from "node:assert/strict";
import test from "node:test";
import { completeNewModelSelection, resolveDefaultReasoningLevel } from "@zcode/provider";

// 切换模型时的默认思考档位（docs/specs/model-selection-default-level.md）：
// 有 `high` 默认 `high`（不再无条件取最贵最慢的最高档），没有 `high` 才退回最后一档；
// 档位名比较归一化（trim + 小写）但写回配置原值；空档位表不造默认值。
// 桌面补全入口与 CLI picker / ListModels 共用这一份实现，所以这里锁住的就是那三处的默认。

test("有 high 时默认 high，而不是最高档", () => {
  assert.equal(resolveDefaultReasoningLevel(["minimal", "low", "medium", "high", "xhigh"]), "high");
});

test("没有 high 时退回最后一档", () => {
  assert.equal(resolveDefaultReasoningLevel(["low", "medium"]), "medium");
  assert.equal(resolveDefaultReasoningLevel(["xhigh", "extra-high"]), "extra-high");
});

test("档位名大小写与首尾空白归一化匹配，写回配置原值", () => {
  assert.equal(resolveDefaultReasoningLevel(["High", "xhigh"]), "High");
  assert.equal(resolveDefaultReasoningLevel(["medium", " HIGH "]), " HIGH ");
});

test("空档位表返回 undefined，不凭空造档位", () => {
  assert.equal(resolveDefaultReasoningLevel([]), undefined);
});

test("completeNewModelSelection 组装出 high 默认档", () => {
  const view = buildCompletionView(["low", "medium", "high", "xhigh"]);
  assert.deepEqual(completeNewModelSelection(view, { providerId: "p1", modelId: "m1" }), {
    providerId: "p1",
    modelId: "m1",
    options: { reasoningLevel: "high" },
  });
});

test("completeNewModelSelection 在无档位表或未知模型时不补档位", () => {
  const view = buildCompletionView([]);
  assert.equal(completeNewModelSelection(view, { providerId: "p1", modelId: "m1" }), undefined);
  assert.equal(
    completeNewModelSelection(view, { providerId: "p1", modelId: "missing" }),
    undefined,
  );
});

function buildCompletionView(reasoningLevels: readonly string[]) {
  return {
    providers: [
      {
        providerId: "p1",
        models: [
          {
            modelId: "m1",
            config: { optionSpecs: { reasoningLevel: { values: reasoningLevels } } },
          },
        ],
      },
    ],
  };
}
