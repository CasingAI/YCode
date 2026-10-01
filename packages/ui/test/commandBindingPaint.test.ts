import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection, ZCodeSlashCommand } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import {
  findCommandModeBinding,
  findCommandModelBinding,
  isCommandBindingModelAvailable,
  resolveCommandBindingRestore,
  resolveCommandMentionPaint,
  resolveCommandModeBindingRestore,
  shouldDeclareCommandBindingExecution,
} from "../src/v4/composer/commandBindingPaint.js";

// 命令绑定着色与发送声明（docs/specs/command-model-binding.md）的判定：
// 插入切草稿并快照、删芯片复原、重挂载不重复快照、模型不可用只提示不切换，
// 以及发送端唯一的「是否仅本轮」比较。

const BINDING: ModelSelection = {
  providerId: "zcode",
  modelId: "glm-5.3",
  options: { reasoningLevel: "high" },
};
const BEFORE: ModelSelection = {
  providerId: "opencode-go-chat",
  modelId: "space-bunny-free",
  options: { reasoningLevel: "low" },
};
const OTHER: ModelSelection = {
  providerId: "zcode",
  modelId: "glm-5.3",
  options: { reasoningLevel: "low" },
};

function view(models: readonly { providerId: string; modelId: string }[]): ModelSelectionView {
  return {
    revision: 1,
    providers: [
      {
        providerId: "zcode",
        models: models.map((model) => ({
          modelId: model.modelId,
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        })),
      },
      {
        providerId: "opencode-go-chat",
        models: [
          {
            modelId: "space-bunny-free",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
        ],
      },
    ],
  } as unknown as ModelSelectionView;
}

const READY_VIEW = view([
  { providerId: "zcode", modelId: "glm-5.3" },
  { providerId: "zcode", modelId: "glm-5.2" },
]);

function catalog(overrides: Partial<ZCodeSlashCommand> = {}): ZCodeSlashCommand[] {
  return [
    {
      name: "compact",
      description: "compact",
      inputHint: "/compact",
      source: "builtin",
      modelSelectionOverride: BINDING,
      ...overrides,
    },
  ] as unknown as ZCodeSlashCommand[];
}

test("目录查绑定：命令名带前导斜杠也能匹配", () => {
  assert.deepEqual(findCommandModelBinding(catalog(), "/Compact"), BINDING);
  assert.equal(findCommandModelBinding(catalog(), "goal"), undefined);
  assert.equal(findCommandModelBinding(undefined, "compact"), undefined);
});

test("可用性：模型不在当前目录时判定为不可用", () => {
  assert.equal(isCommandBindingModelAvailable(READY_VIEW, BINDING), true);
  assert.equal(isCommandBindingModelAvailable(null, BINDING), false);
  assert.equal(
    isCommandBindingModelAvailable(READY_VIEW, { providerId: "zcode", modelId: "gone" }),
    false,
  );
});

test("插入芯片：切到绑定默认并快照进入前的选择", () => {
  const decision = resolveCommandMentionPaint({
    commandName: "compact",
    slashCommands: catalog(),
    draft: { modelSelection: BEFORE },
    modelSelectionView: READY_VIEW,
  });
  assert.deepEqual(decision, {
    kind: "paint",
    paint: { name: "compact", binding: BINDING, snapshot: BEFORE },
    selection: BINDING,
    mode: undefined,
  });
});

test("模型不可用：不切换也不快照", () => {
  const decision = resolveCommandMentionPaint({
    commandName: "compact",
    slashCommands: catalog(),
    draft: { modelSelection: BEFORE },
    modelSelectionView: view([{ providerId: "zcode", modelId: "other" }]),
  });
  assert.deepEqual(decision, { kind: "unavailable" });
});

test("删芯片：仍等于绑定默认时回到进入前的选择", () => {
  const decision = resolveCommandMentionPaint({
    commandName: null,
    slashCommands: catalog(),
    draft: {
      modelSelection: BINDING,
      commandBinding: { name: "compact", binding: BINDING, snapshot: BEFORE },
    },
    modelSelectionView: READY_VIEW,
  });
  assert.deepEqual(decision, { kind: "restore", selection: BEFORE, mode: undefined });
});

test("删芯片：用户改过档位后保留显式选择", () => {
  const decision = resolveCommandMentionPaint({
    commandName: null,
    slashCommands: catalog(),
    draft: {
      modelSelection: OTHER,
      commandBinding: { name: "compact", binding: BINDING, snapshot: BEFORE },
    },
    modelSelectionView: READY_VIEW,
  });
  assert.deepEqual(decision, { kind: "restore", selection: OTHER, mode: undefined });
});

test("重挂载：同一条命令的芯片仍在时不重复快照", () => {
  const decision = resolveCommandMentionPaint({
    commandName: "compact",
    slashCommands: catalog(),
    draft: {
      modelSelection: BINDING,
      commandBinding: { name: "compact", binding: BINDING, snapshot: BEFORE },
    },
    modelSelectionView: READY_VIEW,
  });
  assert.deepEqual(decision, { kind: "none" });
});

test("换成无绑定的命令：复原旧着色", () => {
  const decision = resolveCommandMentionPaint({
    commandName: "goal",
    slashCommands: catalog(),
    draft: {
      modelSelection: BINDING,
      commandBinding: { name: "compact", binding: BINDING, snapshot: BEFORE },
    },
    modelSelectionView: READY_VIEW,
  });
  assert.deepEqual(decision, { kind: "restore", selection: BEFORE, mode: undefined });
});

test("模式绑定：插入切模式并快照，删芯片按是否改过复原", () => {
  const modeCatalog: ZCodeSlashCommand[] = [
    {
      name: "tidy",
      description: "tidy",
      inputHint: "/tidy",
      source: "custom",
      modeOverride: "yolo",
    },
  ] as unknown as ZCodeSlashCommand[];
  assert.equal(findCommandModeBinding(modeCatalog, "/Tidy"), "yolo");
  assert.equal(findCommandModeBinding(modeCatalog, "goal"), undefined);
  const painted = resolveCommandMentionPaint({
    commandName: "tidy",
    slashCommands: modeCatalog,
    draft: { modelSelection: BEFORE, mode: "plan" },
    modelSelectionView: READY_VIEW,
  });
  assert.deepEqual(painted, {
    kind: "paint",
    paint: { name: "tidy", modeBinding: "yolo", modeSnapshot: "plan" },
    selection: undefined,
    mode: "yolo",
  });
  // 仍等于绑定默认：回到进入前的 Plan。
  assert.equal(
    resolveCommandModeBindingRestore({
      mode: "yolo",
      commandBinding: { name: "tidy", modeBinding: "yolo", modeSnapshot: "plan" },
    }),
    "plan",
  );
  // 用户改过模式：保留显式选择。
  assert.equal(
    resolveCommandModeBindingRestore({
      mode: "readonly",
      commandBinding: { name: "tidy", modeBinding: "yolo", modeSnapshot: "plan" },
    }),
    "readonly",
  );
});

test("模型与模式各自独立：只绑模式不碰模型选择", () => {
  const modeOnly: ZCodeSlashCommand[] = [
    {
      name: "tidy",
      description: "tidy",
      inputHint: "/tidy",
      source: "custom",
      modeOverride: "yolo",
    },
  ] as unknown as ZCodeSlashCommand[];
  const decision = resolveCommandMentionPaint({
    commandName: "tidy",
    slashCommands: modeOnly,
    draft: { modelSelection: BEFORE, mode: "plan" },
    modelSelectionView: READY_VIEW,
  });
  assert.equal(decision.kind, "paint");
  if (decision.kind !== "paint") return;
  assert.equal(decision.selection, undefined);
  assert.equal(decision.mode, "yolo");
  assert.deepEqual(decision.paint.snapshot, undefined);
});

test("复原目标：没有着色时等于当前选择", () => {
  assert.equal(resolveCommandBindingRestore({ modelSelection: BEFORE }), BEFORE);
  assert.equal(resolveCommandBindingRestore({}), undefined);
});

test("仅本轮声明：仍等于绑定默认才声明", () => {
  assert.equal(
    shouldDeclareCommandBindingExecution(
      { modelSelection: BINDING, commandBinding: { name: "compact", binding: BINDING } },
      BINDING,
    ),
    true,
  );
  // 档位不同 = 用户改过，不声明，走正常写回。
  assert.equal(
    shouldDeclareCommandBindingExecution(
      { modelSelection: OTHER, commandBinding: { name: "compact", binding: BINDING } },
      OTHER,
    ),
    false,
  );
  assert.equal(shouldDeclareCommandBindingExecution({ modelSelection: BINDING }, BINDING), false);
});
