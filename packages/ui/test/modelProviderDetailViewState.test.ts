import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelProviderDetailViewState } from "../src/settings/model-provider-section/detailViewState.js";

// 零供应商环境的假加载 bug（docs/specs/model-provider-empty-state.md）：
// 未选中 + 数据已就绪 + 无条目 = 空状态，不得复用「加载中」卡片。

test("未选中、加载中、条目未知/非零 → loading", () => {
  assert.equal(
    resolveModelProviderDetailViewState({
      hasSelection: false,
      presetLoading: true,
      navigationItemCount: 0,
    }),
    "loading",
  );
  assert.equal(
    resolveModelProviderDetailViewState({
      hasSelection: false,
      presetLoading: false,
      navigationItemCount: null,
    }),
    "loading",
  );
});

test("未选中、已就绪、零条目 → empty（用户报的假加载场景）", () => {
  assert.equal(
    resolveModelProviderDetailViewState({
      hasSelection: false,
      presetLoading: false,
      navigationItemCount: 0,
    }),
    "empty",
  );
});

test("刷新中且零条目仍视为 loading，不闪空状态", () => {
  assert.equal(
    resolveModelProviderDetailViewState({
      hasSelection: false,
      presetLoading: true,
      navigationItemCount: 0,
    }),
    "loading",
  );
});

test("有选中项 → provider，与加载态无关", () => {
  assert.equal(
    resolveModelProviderDetailViewState({
      hasSelection: true,
      presetLoading: true,
      navigationItemCount: 1,
    }),
    "provider",
  );
});
