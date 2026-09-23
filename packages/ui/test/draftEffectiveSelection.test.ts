import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { resolveDraftEffectiveSelection } from "../src/v4/composer/draftEffectiveSelection.js";

// 草稿展示用有效选择的回落规则（docs/specs/composer-model-switch-continuity.md）：
// 只有已经对应本次草稿选择的 View 才提供生效选择；切换模型的瞬间目录还是上一份，
// 这时用草稿意图，胶囊才能当帧显示目标模型。

const INTENT: ModelSelection = { providerId: "deepseek", modelId: "deepseek-v4.1-flash" };
const RESOLVED: ModelSelection = {
  providerId: "deepseek",
  modelId: "deepseek-v4.1-flash",
  options: { reasoningLevel: "high" },
};

function buildView(overrides: Partial<ModelSelectionView> = {}): ModelSelectionView {
  return { revision: 3, providers: [], ...overrides } as unknown as ModelSelectionView;
}

test("新鲜且已解析：用 View 的结果，不读意图", () => {
  assert.equal(
    resolveDraftEffectiveSelection({
      selectionFresh: true,
      view: buildView({ effectiveSelection: RESOLVED }),
      intent: INTENT,
    }),
    RESOLVED,
  );
});

test("新鲜但结果缺失（selectionIssue）：保持空值，不拿意图冒充生效选择", () => {
  // 这是最容易写错的回归点：目录读到过、解析结果为空，语义是「没有可用选择」。
  assert.equal(
    resolveDraftEffectiveSelection({
      selectionFresh: true,
      view: buildView({ effectiveSelection: null, selectionIssue: "model-not-found" }),
      intent: INTENT,
    }),
    undefined,
  );
});

test("stale（切换瞬间的目录）：回落到草稿意图", () => {
  assert.equal(
    resolveDraftEffectiveSelection({
      selectionFresh: false,
      view: buildView({ effectiveSelection: null }),
      intent: INTENT,
    }),
    INTENT,
  );
});

test("没有视图（未读到目录 / 不可用）：回落到草稿意图", () => {
  assert.equal(
    resolveDraftEffectiveSelection({ selectionFresh: false, view: null, intent: INTENT }),
    INTENT,
  );
  assert.equal(
    resolveDraftEffectiveSelection({ selectionFresh: true, view: null, intent: INTENT }),
    INTENT,
  );
});

test("草稿里没有选择时不造值", () => {
  assert.equal(
    resolveDraftEffectiveSelection({ selectionFresh: false, view: null, intent: undefined }),
    undefined,
  );
});
