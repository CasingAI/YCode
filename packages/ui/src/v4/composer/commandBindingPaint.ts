// 命令绑定着色与发送声明的纯判定层（docs/specs/command-model-binding.md）。
//
// 事实来源有三份：CLI 目录里的 modelSelectionOverride / modeOverride、草稿里的
// commandBinding 快照、以及本次提交冻结下来的 ModelSelection / mode。三者的比较与
// 决策都在这里收口，SessionPane 只负责读目录、读草稿、写草稿与发 toast，避免同一份
// 快照在多个调用点各判一次而分叉。
//
// 模型与模式各自独立快照、各自独立复原：一条命令可以只绑一侧；复原时「草稿仍等于
// 进入时的绑定默认」按侧判定，用户改过的一侧保留显式选择。
import type { ModelSelection, ZCodeSlashCommand } from "@zcode/shared";
import { sameModelSelection } from "@zcode/shared";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";

/** 与 composerDraftStore 的 commandBinding 同形；此处只描述规则，不拥有持久化。 */
export interface CommandBindingPaint {
  name: string;
  binding?: ModelSelection;
  snapshot?: ModelSelection;
  modeBinding?: SubmissionMode;
  modeSnapshot?: SubmissionMode;
}

export interface CommandBindingDraftState {
  modelSelection?: ModelSelection;
  mode?: SubmissionMode;
  commandBinding?: CommandBindingPaint;
}

export type CommandMentionPaintDecision =
  | { kind: "none" }
  | {
      kind: "paint";
      paint: CommandBindingPaint;
      selection: ModelSelection | undefined;
      mode: SubmissionMode | undefined;
    }
  | {
      kind: "restore";
      selection: ModelSelection | undefined;
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

/**
 * 复原只在「草稿仍等于进入时的绑定默认」时执行：用户改过模型或思考深度就保留
 * 显式选择，只清着色快照，交给正常的 accepted 写回链路。
 */
export function resolveCommandBindingRestore(
  draft: CommandBindingDraftState,
): ModelSelection | undefined {
  const current = draft.commandBinding;
  if (!current) return draft.modelSelection;
  if (!current.binding) return draft.modelSelection;
  return sameModelSelection(draft.modelSelection, current.binding)
    ? current.snapshot
    : draft.modelSelection;
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
      mode: resolveCommandModeBindingRestore(draft),
    };
  };
  if (!commandName) return restore();
  const target = normalizeCommandBindingName(commandName);
  if (!target) return { kind: "none" };
  const binding = findCommandModelBinding(slashCommands, commandName);
  const modeBinding = findCommandModeBinding(slashCommands, commandName);
  if (!binding && !modeBinding) return restore();
  // 已经为这条命令着色过（重挂载后正文芯片仍在、或用户手动改了模型/模式）：不重复快照，
  // 否则会把绑定值本身当成「进入前的选择」，删芯片后就回不去了。
  if (draft.commandBinding && normalizeCommandBindingName(draft.commandBinding.name) === target) {
    return { kind: "none" };
  }
  if (binding && !isCommandBindingModelAvailable(modelSelectionView, binding))
    return { kind: "unavailable" };
  const modelSnapshot = draft.commandBinding
    ? resolveCommandBindingRestore(draft)
    : draft.modelSelection;
  const snapshotMode = draft.commandBinding ? resolveCommandModeBindingRestore(draft) : draft.mode;
  return {
    kind: "paint",
    paint: {
      name: target,
      ...(binding ? { binding, ...(modelSnapshot ? { snapshot: modelSnapshot } : {}) } : {}),
      ...(modeBinding
        ? { modeBinding, ...(snapshotMode ? { modeSnapshot: snapshotMode } : {}) }
        : {}),
    },
    selection: binding,
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
): boolean {
  const current = draft.commandBinding;
  if (!current?.binding || !submittedSelection) return false;
  return sameModelSelection(submittedSelection, current.binding);
}
