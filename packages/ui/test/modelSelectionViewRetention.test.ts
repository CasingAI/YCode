import assert from "node:assert/strict";
import test from "node:test";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup } from "../src/ModelConfigSelect.js";
import { encodeCustomModelValue } from "../src/lib/zcodeCustomModelValue.js";
import { resolveDraftEffectiveSelection } from "../src/v4/composer/draftEffectiveSelection.js";
import { resolveV4ModelTriggerDisplay } from "../src/v4/composer/modelTriggerDisplay.js";
import {
  initialModelSelectionState,
  isModelSelectionStateFresh,
  ownsModelSelection,
  projectModelSelectionCatalog,
  resolveVisibleModelSelectionState,
  type ModelSelectionOwnership,
  type ModelSelectionState,
  type OwnedModelSelectionState,
} from "../src/hooks/modelSelectionViewState.js";

// 切换模型时的显示连续性（docs/specs/composer-model-switch-continuity.md）：
// 只有 input.selection 派生的 effectiveSelection / selectionIssue 随选择失效，
// providers / revision / preferredSelection 与选择无关，跨输入变化继续可展示。

function buildView(overrides: Partial<ModelSelectionView> = {}): ModelSelectionView {
  return {
    revision: 7,
    providers: [
      {
        providerId: "deepseek",
        providerName: "DeepSeek",
        models: [{ modelId: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" }],
      },
    ],
    preferredSelection: { providerId: "deepseek", modelId: "deepseek-v4.1-flash" },
    effectiveSelection: { providerId: "deepseek", modelId: "deepseek-v4.1-flash" },
    selectionIssue: "reasoning-level-missing",
    ...overrides,
  } as unknown as ModelSelectionView;
}

const view = buildView();
const SERVICE = { getView: async () => view } as unknown as IModelSelectionService;
const OTHER_SERVICE = { getView: async () => view } as unknown as IModelSelectionService;

const TARGET: ModelSelectionOwnership = {
  service: SERVICE,
  enabled: true,
  unavailableReason: "remote-waiting",
};

function ownedWith(
  state: ModelSelectionState,
  inputKey: string | undefined,
): OwnedModelSelectionState {
  return {
    service: SERVICE,
    enabled: true,
    unavailableReason: "remote-waiting",
    inputKey,
    state,
  };
}

test("输入变化时保留目录：status 仍是 ready 且标记 stale", () => {
  const owned = ownedWith({ status: "ready", view }, '{"selection":{"modelId":"glm-5.3"}}');
  const { state, selectionFresh } = resolveVisibleModelSelectionState({
    owned,
    target: TARGET,
    inputKey: '{"selection":{"modelId":"deepseek-v4.1-flash"}}',
  });

  assert.equal(state.status, "ready");
  assert.equal(state.status === "ready" && state.stale, true);
  assert.equal(selectionFresh, false);
  // 目录仍在：工具条因此不会退回「管理模型」占位，也不会被禁用。
  assert.equal(state.status === "ready" && state.view.providers.length, 1);
  assert.equal(state.status === "ready" && state.view.revision, 7);
});

test("stale 视图剔除由选择派生的字段，消费方读不到上一次选择的结果", () => {
  const owned = ownedWith({ status: "ready", view }, "old-key");
  const { state } = resolveVisibleModelSelectionState({
    owned,
    target: TARGET,
    inputKey: "new-key",
  });

  assert.equal(state.status === "ready" && state.view.effectiveSelection, undefined);
  assert.equal(state.status === "ready" && state.view.selectionIssue, undefined);
  // 原始视图不被改写，后续解析结果仍是完整视图。
  assert.equal(view.effectiveSelection?.modelId, "deepseek-v4.1-flash");
  assert.equal(view.selectionIssue, "reasoning-level-missing");
});

test("目录投影同源视图返回稳定引用，避免下游 useMemo 重建分组", () => {
  const projected = projectModelSelectionCatalog(view);
  assert.equal(projectModelSelectionCatalog(view), projected);
  assert.deepEqual(Object.keys(projected).sort(), ["preferredSelection", "providers", "revision"]);
});

test("输入不变且已解析：引用与新鲜度都不变", () => {
  const state: ModelSelectionState = { status: "ready", view };
  const owned = ownedWith(state, "same-key");
  const visible = resolveVisibleModelSelectionState({
    owned,
    target: TARGET,
    inputKey: "same-key",
  });

  assert.equal(visible.state, state);
  assert.equal(visible.selectionFresh, true);
  assert.equal(isModelSelectionStateFresh(state), true);
});

test("owner 身份变化不保留目录：切 workspace / 远控未连接一律回到初始态", () => {
  const owned = ownedWith({ status: "ready", view }, "same-key");
  const otherHost: ModelSelectionOwnership = { ...TARGET, service: OTHER_SERVICE };
  const disabled: ModelSelectionOwnership = { ...TARGET, enabled: false };
  const missingTarget: ModelSelectionOwnership = {
    ...TARGET,
    enabled: false,
    unavailableReason: "missing-target",
  };

  assert.deepEqual(
    resolveVisibleModelSelectionState({ owned, target: otherHost, inputKey: "same-key" }).state,
    { status: "loading" },
  );
  assert.deepEqual(
    resolveVisibleModelSelectionState({ owned, target: disabled, inputKey: "same-key" }).state,
    { status: "unavailable", reason: "remote-waiting" },
  );
  assert.deepEqual(
    resolveVisibleModelSelectionState({ owned, target: missingTarget, inputKey: "same-key" }).state,
    { status: "unavailable", reason: "missing-target" },
  );
  assert.equal(ownsModelSelection(owned, otherHost), false);
  assert.equal(ownsModelSelection(owned, TARGET), true);
});

test("从未读到目录时不保留：loading / error 仍是初始态（占位与禁用只属于这种情况）", () => {
  const loading = ownedWith(initialModelSelectionState(SERVICE, true, "remote-waiting"), "old-key");
  const failed = ownedWith({ status: "error", error: new Error("boom") }, "old-key");

  assert.deepEqual(
    resolveVisibleModelSelectionState({ owned: loading, target: TARGET, inputKey: "new-key" }),
    { state: { status: "loading" }, selectionFresh: false },
  );
  assert.deepEqual(
    resolveVisibleModelSelectionState({ owned: failed, target: TARGET, inputKey: "new-key" }),
    { state: { status: "error", error: new Error("boom") }, selectionFresh: false },
  );
});

test("stale 状态保持 ready：解析完成后才回到新鲜", () => {
  const stale: ModelSelectionState = {
    status: "ready",
    view: projectModelSelectionCatalog(view),
    stale: true,
  };
  assert.equal(isModelSelectionStateFresh(stale), false);
  const resolved: ModelSelectionState = { status: "ready", view };
  assert.equal(isModelSelectionStateFresh(resolved), true);

  // 目录复用后再次传入同一输入（effect 已接受新键）仍是 stale，直到 read 提交。
  const owned = ownedWith(stale, "new-key");
  const visible = resolveVisibleModelSelectionState({ owned, target: TARGET, inputKey: "new-key" });
  assert.equal(visible.selectionFresh, false);
  assert.equal(visible.state.status === "ready" && visible.state.stale, true);
});

test("显示后果：有目录时按目标模型出展示名，只有空目录才落回占位", () => {
  const providerId = "deepseek";
  const modelId = "deepseek-v4.1-flash";
  const normalizedValue = encodeCustomModelValue(providerId, modelId);
  const groups: ModelSelectGroup[] = [
    {
      key: `registry-provider:${providerId}`,
      label: "DeepSeek",
      items: [{ key: `${providerId}:${modelId}`, value: normalizedValue, name: modelId }],
    },
  ];
  const params = { normalizedValue, fallbackLabel: "管理模型", providerId };

  // 保留目录（stale 帧）→ 目标展示名，不会闪回占位。
  assert.equal(
    resolveV4ModelTriggerDisplay({ ...params, modelGroups: groups }).modelLabel,
    "Deepseek V4.1 Flash",
  );
  // 目录为空（从未读到）→ 仍是占位，这是本次保留的既有行为。
  assert.equal(resolveV4ModelTriggerDisplay({ ...params, modelGroups: [] }).modelLabel, "管理模型");
});

test("切换瞬间的整条链路：胶囊当帧显示目标模型，不经过占位", () => {
  // 点击前：目录对应旧选择，胶囊显示旧模型。
  const oldSelection = { providerId: "deepseek", modelId: "glm-5.3-flash" } as const;
  const owned = ownedWith({ status: "ready", view }, JSON.stringify({ selection: oldSelection }));
  const target = { providerId: "deepseek", modelId: "deepseek-v4.1-flash" } as const;

  // 点击后同一帧：调用方输入已是目标选择，目录还是上一份。
  const visible = resolveVisibleModelSelectionState({
    owned,
    target: TARGET,
    inputKey: JSON.stringify({ selection: target }),
  });
  assert.equal(visible.state.status, "ready");

  // 工具条读到的视图仍是保留目录；有效选择回落草稿意图。
  const retainedView = visible.state.status === "ready" ? visible.state.view : null;
  const effectiveSelection = resolveDraftEffectiveSelection({
    selectionFresh: visible.selectionFresh,
    view: retainedView,
    intent: target,
  });
  assert.deepEqual(effectiveSelection, target);

  // 目录里含目标模型时，触发器当帧就是目标展示名；空目录才会出现占位那一帧。
  const normalizedValue = encodeCustomModelValue(target.providerId, target.modelId);
  const groups: ModelSelectGroup[] = [
    {
      key: `registry-provider:${target.providerId}`,
      label: "DeepSeek",
      items: [
        {
          key: "old",
          value: encodeCustomModelValue("deepseek", "glm-5.3-flash"),
          name: "glm-5.3-flash",
        },
        { key: "new", value: normalizedValue, name: target.modelId },
      ],
    },
  ];
  assert.equal(
    resolveV4ModelTriggerDisplay({
      modelGroups: groups,
      normalizedValue,
      fallbackLabel: "管理模型",
      providerId: target.providerId,
    }).modelLabel,
    "Deepseek V4.1 Flash",
  );
});
