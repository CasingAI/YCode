import { completeNewModelSelection } from "@zcode/provider";
import type { ModelSelectionView } from "@zcode/services";
import type {
  ModelGroupIntent,
  ModelSelection,
  UserCommand,
} from "@zcode/shared";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { decodeModelGroupSelectValue } from "@/lib/modelSelectionGroups.js";
import {
  INHERIT_MODEL_VALUE,
  toOverrideModelGroupIntent,
  toOverrideModelSelection,
  toOverrideModelValue,
} from "@/settings/ModelOverrideControl.js";

// 命令表单模型/模式绑定的纯计算层（docs/specs/model-group.md）。
// CommandForm 只负责 state 与渲染；组意图与具体模型互斥、新建/编辑两步语义
// （未动不碰文件头）的判定收口在这里，避免表单组件堆叠分支超行数上限。

/** 换模型/组时跟随的档位：组意图不带档位，直接清空；具体模型补默认档。 */
export function resolveCommandFormThoughtOnModelChange(
  modelSelectionView: ModelSelectionView | null | undefined,
  nextModel: string | undefined,
): string | undefined {
  if (!nextModel) return undefined;
  if (decodeModelGroupSelectValue(nextModel) !== null) return undefined;
  const completed = modelSelectionView
    ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(nextModel))
    : undefined;
  return completed?.options?.reasoningLevel;
}

export interface CommandFormModelBinding {
  modelSelection: ModelSelection | undefined;
  modelGroupIntent: ModelGroupIntent | undefined;
  modelTouched: boolean;
}

/** 模型区提交值：选组写组意图（含组名快照），选具体模型写具体模型。 */
export function resolveCommandFormModelBinding(params: {
  initial?: UserCommand;
  normalizedModelValue: string;
  thoughtLevel: string | undefined;
  modelSelectionView?: ModelSelectionView | null;
}): CommandFormModelBinding {
  const { initial, normalizedModelValue, thoughtLevel, modelSelectionView } = params;
  const nextGroupIntent =
    decodeModelGroupSelectValue(normalizedModelValue) !== null
      ? toOverrideModelGroupIntent(normalizedModelValue, modelSelectionView)
      : undefined;
  // 新建命令没有可继承的旧绑定：表单选了模型即新绑定，未选即无绑定。
  // 编辑命令：未动模型区（仍等于 initial 绑定）即 undefined，调用方跳过覆盖写，
  // 避免表单保存重写文件头时丢掉行外改过的绑定。
  const nextSelection = nextGroupIntent
    ? undefined
    : toOverrideModelSelection(
        normalizedModelValue === INHERIT_MODEL_VALUE ? undefined : normalizedModelValue,
        thoughtLevel,
      );
  const initialModelValue = initial?.modelGroupIntentOverride
    ? toOverrideModelValue(undefined, initial.modelGroupIntentOverride)
    : initial?.modelSelectionOverride
      ? toOverrideModelValue(initial.modelSelectionOverride)
      : INHERIT_MODEL_VALUE;
  const initialThoughtLevel = initial?.modelGroupIntentOverride
    ? undefined
    : initial?.modelSelectionOverride?.options?.reasoningLevel;
  const modelTouched = initial
    ? normalizedModelValue !== initialModelValue || thoughtLevel !== initialThoughtLevel
    : nextGroupIntent !== undefined || nextSelection !== undefined;
  return {
    modelSelection: nextSelection,
    modelGroupIntent: nextGroupIntent,
    modelTouched,
  };
}

export interface CommandFormModeBinding {
  mode: SubmissionMode | undefined;
  modeTouched: boolean;
}

/** 模式区提交值：新建时选了即新绑定；编辑时未动则调用方跳过 mode 键覆盖写。 */
export function resolveCommandFormModeBinding(params: {
  initial?: UserCommand;
  modeValue: string;
}): CommandFormModeBinding {
  const { initial, modeValue } = params;
  const initialMode = initial?.modeOverride ?? INHERIT_MODEL_VALUE;
  const nextMode: SubmissionMode | undefined =
    modeValue === INHERIT_MODEL_VALUE ? undefined : (modeValue as SubmissionMode);
  return { mode: nextMode, modeTouched: initial ? modeValue !== initialMode : nextMode !== undefined };
}
