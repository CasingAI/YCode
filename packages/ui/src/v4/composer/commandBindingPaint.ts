// 命令绑定着色与发送声明的纯判定层（docs/specs/command-model-binding.md）。
//
// 事实来源有三份：CLI 目录里的 modelSelectionOverride / modeOverride、草稿里的
// commandBinding 快照、以及本次提交冻结下来的 ModelSelection / mode。三者的比较与
// 决策都在这里收口，SessionPane 只负责读目录、读草稿、写草稿与发 toast，避免同一份
// 快照在多个调用点各判一次而分叉。
//
// 模型与模式各自独立快照、各自独立复原：一条命令可以只绑一侧；复原时「草稿仍等于
// 进入时的绑定默认」按侧判定，用户改过的一侧保留显式选择。
import type { ModelGroupIntent, ModelSelection, ZCodeSlashCommand } from "@zcode/shared";
import { sameModelGroupIntent, sameModelSelection } from "@zcode/shared";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";

/** 与 composerDraftStore 的 commandBinding 同形；此处只描述规则，不拥有持久化。 */
export interface CommandBindingPaint {
  name: string;
  binding?: ModelSelection;
  /** 组意图绑定（docs/specs/model-group.md）：与 binding 互斥，发送时由 admission 钉死。 */
  groupBinding?: ModelGroupIntent;
  snapshot?: ModelSelection;
  /** 进入时的组意图快照；删芯片时复原组着色。 */
  groupSnapshot?: ModelGroupIntent;
  modeBinding?: SubmissionMode;
  modeSnapshot?: SubmissionMode;
}

export interface CommandBindingDraftState {
  modelSelection?: ModelSelection;
  /** 草稿组意图（docs/specs/model-group.md）：与 modelSelection 互斥。 */
  modelGroupIntent?: ModelGroupIntent;
  mode?: SubmissionMode;
  commandBinding?: CommandBindingPaint;
}

export type CommandMentionPaintDecision =
  | { kind: "none" }
  | {
      kind: "paint";
      paint: CommandBindingPaint;
      selection: ModelSelection | undefined;
      /** 组着色时的组意图；具体模型分支为 undefined。 */
      groupIntent: ModelGroupIntent | undefined;
      mode: SubmissionMode | undefined;
    }
  | {
      kind: "restore";
      selection: ModelSelection | undefined;
      groupIntent: ModelGroupIntent | undefined;
      mode: SubmissionMode | undefined;
    }
  | { kind: "unavailable" };

export function normalizeCommandBindingName(name: string): string {
  // 与输入框面板的 normalizeSlashCommandValue 同形：远端可能直接回 "/init"。
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function findCommandModelBinding(
  slashCommands: readonly ZCodeSlashCommand[] | undefined,
  commandName: string,
): ModelSelection | undefined {
  const target = normalizeCommandBindingName(commandName);
  if (!target) return undefined;
  return slashCommands?.find((command) => normalizeCommandBindingName(command.name) === target)
    ?.modelSelectionOverride;
}

/** 组意图绑定查找（docs/specs/model-group.md）：与具体模型绑定互斥，组优先。 */
export function findCommandModelGroupBinding(
  slashCommands: readonly ZCodeSlashCommand[] | undefined,
  commandName: string,
): ModelGroupIntent | undefined {
  const target = normalizeCommandBindingName(commandName);
  if (!target) return undefined;
  return slashCommands?.find((command) => normalizeCommandBindingName(command.name) === target)
    ?.modelGroupIntentOverride;
}

export function findCommandModeBinding(
  slashCommands: readonly ZCodeSlashCommand[] | undefined,
  commandName: string,
): SubmissionMode | undefined {
  const target = normalizeCommandBindingName(commandName);
  if (!target) return undefined;
  return slashCommands?.find((command) => normalizeCommandBindingName(command.name) === target)
    ?.modeOverride;
}

/** 绑定模型在当前目录不可用时不切换（spec 失效语义）；档位对齐留给 runtime 降级。 */
export function isCommandBindingModelAvailable(
  modelSelectionView: ModelSelectionView | null,
  binding: ModelSelection,
): boolean {
  return Boolean(
    modelSelectionView?.providers
      .find((provider) => provider.providerId === binding.providerId)
      ?.models.some((model) => model.modelId === binding.modelId),
  );
}

/** 组绑定在当前视图不可用（组已删/停用）时不着色（spec 失效语义）；发送侧不静默切换。 */
export function isCommandBindingGroupAvailable(
  modelSelectionView: ModelSelectionView | null,
  groupIntent: ModelGroupIntent,
): boolean {
  return Boolean(
    modelSelectionView?.modelGroups?.some((group) => group.groupId === groupIntent.groupId),
  );
}

/**
 * 复原只在「草稿仍等于进入时的绑定默认」时执行：用户改过模型或思考深度就保留
 * 显式选择，只清着色快照，交给正常的 accepted 写回链路。
 */
export function resolveCommandBindingRestore(
  draft: CommandBindingDraftState,
): ModelSelection | undefined {
  const current = draft.commandBinding;
  if (!current) return draft.modelSelection;
  if (!current.binding && !current.groupBinding) return draft.modelSelection;
  if (current.binding) {
    return sameModelSelection(draft.modelSelection, current.binding)
      ? current.snapshot
      : draft.modelSelection;
  }
  // 组着色分支：草稿仍等于组绑定默认才复原进入前的选择，用户改过则保留显式选择。
  return draft.modelGroupIntent && current.groupBinding
    ? sameModelGroupIntent(draft.modelGroupIntent, current.groupBinding)
      ? draft.modelSelection
      : draft.modelSelection
    : draft.modelSelection;
}

/**
 * 组复原（docs/specs/model-group.md）：草稿仍等于组绑定默认才回到进入前的组快照。
 */
export function resolveCommandGroupBindingRestore(
  draft: CommandBindingDraftState,
): ModelGroupIntent | undefined {
  const current = draft.commandBinding;
  if (!current) return draft.modelGroupIntent;
  if (!current.groupBinding) return draft.modelGroupIntent;
  return draft.modelGroupIntent && sameModelGroupIntent(draft.modelGroupIntent, current.groupBinding)
    ? current.groupSnapshot
    : draft.modelGroupIntent;
}

/**
 * 模式复原与模型同规则：草稿仍等于绑定默认才回到进入前的快照，用户改过模式则保留。
 */
export function resolveCommandModeBindingRestore(
  draft: CommandBindingDraftState,
): SubmissionMode | undefined {
  const current = draft.commandBinding;
  if (!current) return draft.mode;
  if (!current.modeBinding) return draft.mode;
  return draft.mode === current.modeBinding ? current.modeSnapshot : draft.mode;
}

/**
 * 芯片增删 → 草稿着色决策。
 *
 * 删芯片或换成无绑定的命令走复原；换另一条有绑定的命令时，新快照取「旧着色的复原
 * 目标」而不是当前值，否则连续换命令会把中间那次绑定当成进入前的选择。
 */
export function resolveCommandMentionPaint(params: {
  commandName: string | null;
  slashCommands: readonly ZCodeSlashCommand[] | undefined;
  draft: CommandBindingDraftState;
  modelSelectionView: ModelSelectionView | null;
}): CommandMentionPaintDecision {
  const { commandName, slashCommands, draft, modelSelectionView } = params;
  const restore = (): CommandMentionPaintDecision => {
    if (!draft.commandBinding) return { kind: "none" };
    return {
      kind: "restore",
      selection: resolveCommandBindingRestore(draft),
      groupIntent: resolveCommandGroupBindingRestore(draft),
      mode: resolveCommandModeBindingRestore(draft),
    };
  };
  if (!commandName) return restore();
  const target = normalizeCommandBindingName(commandName);
  if (!target) return { kind: "none" };
  const binding = findCommandModelBinding(slashCommands, commandName);
  // 组意图与具体模型互斥（docs/specs/model-group.md）：有组按组着色，不读具体模型。
  const groupBinding = binding ? undefined : findCommandModelGroupBinding(slashCommands, commandName);
  const modeBinding = findCommandModeBinding(slashCommands, commandName);
  if (!binding && !groupBinding && !modeBinding) return restore();
  // 已经为这条命令着色过（重挂载后正文芯片仍在、或用户手动改了模型/模式）：不重复快照，
  // 否则会把绑定值本身当成「进入前的选择」，删芯片后就回不去了。
  if (draft.commandBinding && normalizeCommandBindingName(draft.commandBinding.name) === target) {
    return { kind: "none" };
  }
  if (binding && !isCommandBindingModelAvailable(modelSelectionView, binding))
    return { kind: "unavailable" };
  // 绑定组已删或停用（不在当前视图）时芯片置不可用并提示，不静默切换成别的模型。
  if (groupBinding && !isCommandBindingGroupAvailable(modelSelectionView, groupBinding))
    return { kind: "unavailable" };
  const modelSnapshot = draft.commandBinding
    ? resolveCommandBindingRestore(draft)
    : draft.modelSelection;
  const groupSnapshot = draft.commandBinding
    ? resolveCommandGroupBindingRestore(draft)
    : draft.modelGroupIntent;
  const snapshotMode = draft.commandBinding ? resolveCommandModeBindingRestore(draft) : draft.mode;
  return {
    kind: "paint",
    paint: {
      name: target,
      ...(binding ? { binding, ...(modelSnapshot ? { snapshot: modelSnapshot } : {}) } : {}),
      ...(groupBinding
        ? { groupBinding, ...(groupSnapshot ? { groupSnapshot } : {}) }
        : {}),
      ...(modeBinding
        ? { modeBinding, ...(snapshotMode ? { modeSnapshot: snapshotMode } : {}) }
        : {}),
    },
    selection: binding,
    groupIntent: groupBinding,
    mode: modeBinding,
  };
}

/**
 * 发送端唯一的「是否仅本轮」判定：本次提交仍等于插入时锁定的绑定默认才声明
 * execution 作用域；用户改过模型或思考深度则不声明，走正常写回。
 */
export function shouldDeclareCommandBindingExecution(
  draft: CommandBindingDraftState,
  submittedSelection: ModelSelection | undefined,
  submittedGroupIntent?: ModelGroupIntent,
): boolean {
  const current = draft.commandBinding;
  if (current?.groupBinding) {
    if (!submittedGroupIntent) return false;
    return sameModelGroupIntent(submittedGroupIntent, current.groupBinding);
  }
  if (!current?.binding || !submittedSelection) return false;
  return sameModelSelection(submittedSelection, current.binding);
}
