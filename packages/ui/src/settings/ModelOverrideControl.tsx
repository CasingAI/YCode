// 「模型 + 思考深度」覆盖控件的公共实现：
// 内置子智能体（SubagentsSection）、系统命令详情页（BuiltinCommandDetail）共用即改即存语义；
// 用户自定义命令的编辑表单（CommandForm）只复用其中的纯函数（值编解码、可用性判定），
// 表单内走延迟态（点保存才落盘），不直接用本控件。
// 即改即存语义统一：本地乐观更新 → onPersist 落盘 → 失败回滚；换模型必须连默认档位一起补齐。
import { useCallback, useEffect, useMemo, useState } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import {
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveModelDisplayName } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import {
  SubagentReasoningField,
  type SubagentReasoningFieldState,
} from "@/settings/SubagentReasoningField.js";

export const MODEL_OVERRIDE_ITEM_NEVER_LOCKED = () => false;
export const INHERIT_MODEL_VALUE = "inherit";

export function toPersistedModel(model: string): string | undefined {
  const trimmedModel = model.trim();
  return trimmedModel && trimmedModel !== INHERIT_MODEL_VALUE ? trimmedModel : undefined;
}

export function toOverrideModelValue(selection: ModelSelection | undefined): string {
  return selection
    ? encodeCustomModelValue(selection.providerId, selection.modelId)
    : INHERIT_MODEL_VALUE;
}

export function toOverrideModelSelection(
  model: string | undefined,
  thoughtLevel?: string,
): ModelSelection | undefined {
  const persistedModel = model ? toPersistedModel(model) : undefined;
  if (!persistedModel) return undefined;
  const selection = parseModelPickerValue(persistedModel);
  const reasoningLevel = thoughtLevel?.trim();
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

export type OverrideThoughtOptionState = SubagentReasoningFieldState;

export function resolveOverrideThoughtOptionState(params: {
  model: string;
  modelAvailable: boolean;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  thoughtLevel?: string;
}): OverrideThoughtOptionState {
  const persistedModel = toPersistedModel(params.model);
  if (!persistedModel || !params.modelAvailable) {
    return { kind: "not-applicable" };
  }
  const modelSelection = parseModelPickerValue(persistedModel);
  const explicitThoughtLevel = params.thoughtLevel?.trim();

  // Settings 只管理 Local Environment，模型能力与候选统一来自 Local Host View。
  // Workspace presentation 的 configOptions 不是第二份模型目录，也不参与 reasoning 判断。
  const metadataOption = params.modelSelectionView
    ? resolveModelThoughtOption({
        modelSelectionView: params.modelSelectionView,
        providerId: modelSelection.providerId,
        modelId: modelSelection.modelId,
        currentValue: explicitThoughtLevel,
      })
    : null;
  if (metadataOption) {
    return {
      kind: "supported",
      option: metadataOption,
    };
  }
  if (params.modelSelectionLoading) {
    return { kind: "unknown", status: "loading" };
  }
  return { kind: "unsupported" };
}

export function isOverrideThoughtLevelAvailable(
  state: OverrideThoughtOptionState,
  thoughtLevel: string | undefined,
): boolean {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return true;
  }
  if (state.kind === "unknown" || state.kind === "not-applicable") {
    return true;
  }
  if (state.kind === "unsupported") {
    return false;
  }
  return Boolean(
    state.option.type === "select" &&
    state.option.options?.some((entry) => entry.value === normalizedThoughtLevel),
  );
}

export function resolvedOverrideThoughtLevel(
  state: OverrideThoughtOptionState,
): string | undefined {
  return state.kind === "supported" && typeof state.option.currentValue === "string"
    ? state.option.currentValue
    : undefined;
}

export function isOverrideModelAvailable(
  modelGroups: readonly ModelSelectGroup[],
  model: string | undefined,
  modelSelectionLoading = false,
): boolean {
  const trimmedModel = model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return true;
  }
  if (modelSelectionLoading) {
    return true;
  }
  return modelGroups.some((group) => group.items.some((item) => item.value === trimmedModel));
}

export function resolveOverrideModelLabel(params: {
  inheritLabel: string;
  modelGroups: readonly ModelSelectGroup[];
  model: string | undefined;
}): string {
  const trimmedModel = params.model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return params.inheritLabel;
  }
  // Registry 只包含当前可选模型，但历史覆盖配置仍需展示原模型身份，
  // 方便用户理解并修复失效配置。候选列表与保存校验继续以 Registry 为准。
  return resolveModelDisplayName(params.modelGroups, trimmedModel) ?? trimmedModel;
}

export interface ModelOverrideControlProps {
  /** 当前持久化的覆盖；undefined = 跟随默认。 */
  selectionOverride?: ModelSelection;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
  disabled?: boolean;
  /** 即改即存：接收模型 + 档位的显式值；组件已做乐观更新与失败回滚。 */
  onPersist: (next: { model?: string; thoughtLevel?: string }) => Promise<void>;
  /** 可选的 start-plan 推荐钩子；返回 null 表示用户放弃，控件回滚。 */
  recommendSelection?: (selection: ModelSelection) => Promise<ModelSelection | null>;
  /** footer「跟随默认」项的去重 key。 */
  footerActionKey?: string;
  /** 档位不可用时的提示文案 i18n id。 */
  thoughtLevelInvalidMessageId?: string;
  /** 传给触发器的 data-testid（无则不输出）。 */
  triggerTestId?: string;
}

/** 行内模型覆盖控件：目录下拉 +「跟随默认」+ 思考深度，即改即存。 */
export function ModelOverrideControl({
  selectionOverride,
  modelGroups,
  modelSelectionView,
  modelSelectionLoading,
  disabled = false,
  onPersist,
  recommendSelection,
  footerActionKey = "model-override:default",
  thoughtLevelInvalidMessageId = "settings.subagents.form.validation.thoughtLevelUnavailable",
  triggerTestId,
}: ModelOverrideControlProps) {
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  const [config, setConfig] = useState<{ model?: string; thoughtLevel?: string }>(() => ({
    model: selectionOverride ? toOverrideModelValue(selectionOverride) : undefined,
    thoughtLevel: selectionOverride?.options?.reasoningLevel,
  }));
  const defaultLabel = intl.formatMessage({ id: "settings.subagents.model.defaultMain" });
  const selectModelLabel = intl.formatMessage({ id: "settings.subagents.model.select" });
  const value = config.model ?? INHERIT_MODEL_VALUE;
  const modelAvailable = isOverrideModelAvailable(modelGroups, value, modelSelectionLoading);
  const thoughtLevelState = resolveOverrideThoughtOptionState({
    model: value,
    modelAvailable,
    modelSelectionView,
    modelSelectionLoading,
    thoughtLevel: config.thoughtLevel,
  });
  const thoughtLevelInvalid = Boolean(
    config.thoughtLevel &&
    modelAvailable &&
    !isOverrideThoughtLevelAvailable(thoughtLevelState, config.thoughtLevel),
  );
  // Coding Plan 连接切换后，旧覆盖模型可能不再属于当前候选；仅隐藏 reasoning
  // 会让用户误以为模型仍有效，因此触发器改用「选择模型」提示，候选列表仍只展示当前连接。
  const triggerLabel =
    value === INHERIT_MODEL_VALUE
      ? defaultLabel
      : !modelAvailable
        ? selectModelLabel
        : resolveOverrideModelLabel({ inheritLabel: defaultLabel, modelGroups, model: value });
  useEffect(() => {
    setConfig({
      model: selectionOverride ? toOverrideModelValue(selectionOverride) : undefined,
      thoughtLevel: selectionOverride?.options?.reasoningLevel,
    });
  }, [selectionOverride]);

  const persistConfig = useCallback(
    async (nextConfig: { model?: string; thoughtLevel?: string }) => {
      if (pending) {
        return;
      }
      const previousConfig = config;
      setConfig(nextConfig);
      setPending(true);
      try {
        let selectedConfig = nextConfig;
        if (nextConfig.model && nextConfig.model !== config.model && recommendSelection) {
          const selection = toOverrideModelSelection(nextConfig.model, nextConfig.thoughtLevel);
          const chosen = selection ? await recommendSelection(selection) : null;
          if (!chosen) {
            setConfig(previousConfig);
            return;
          }
          selectedConfig = {
            model: toOverrideModelValue(chosen),
            thoughtLevel: chosen.options?.reasoningLevel,
          };
        }
        await onPersist(selectedConfig);
        setConfig(selectedConfig);
      } catch {
        setConfig(previousConfig);
      } finally {
        setPending(false);
      }
    },
    [config, onPersist, pending, recommendSelection],
  );
  const handleValueChange = useCallback(
    (nextValue: string) => {
      const nextModel = nextValue === INHERIT_MODEL_VALUE ? undefined : nextValue;
      if (nextModel === config.model) {
        return;
      }
      const nextModelAvailable = isOverrideModelAvailable(
        modelGroups,
        nextValue,
        modelSelectionLoading,
      );
      const nextThoughtState = resolveOverrideThoughtOptionState({
        model: nextValue,
        modelAvailable: nextModelAvailable,
        modelSelectionView,
        modelSelectionLoading,
        thoughtLevel:
          nextModel && modelSelectionView
            ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(nextModel))
                ?.options?.reasoningLevel
            : undefined,
      });
      // 控件会展示 Registry 的正常默认档位，持久化必须保存同一个值，
      // 不能让界面有值而执行 Selection 缺少 reasoningLevel。
      void persistConfig({
        model: nextModel,
        thoughtLevel: resolvedOverrideThoughtLevel(nextThoughtState),
      });
    },
    [config.model, modelGroups, modelSelectionLoading, modelSelectionView, persistConfig],
  );
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: footerActionKey,
        label: defaultLabel,
        onSelect: () => handleValueChange(INHERIT_MODEL_VALUE),
        selected: value === INHERIT_MODEL_VALUE,
      },
    ],
    [defaultLabel, footerActionKey, handleValueChange, value],
  );

  return (
    <div className="flex min-w-0 max-w-full flex-col items-end gap-1">
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        <span
          {...(triggerTestId
            ? { "data-testid": triggerTestId, "data-model-current-value": value }
            : {})}
          className="inline-flex min-w-0"
        >
          <ModelConfigSelect
            modelGroups={modelGroups}
            normalizedValue={value}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_OVERRIDE_ITEM_NEVER_LOCKED}
            onValueChange={handleValueChange}
            footerActions={footerActions}
            manageModelsLabel={intl.formatMessage({ id: "chat.toolbar.model.manageModels" })}
            contentSide="top"
            contentAlign="end"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-8 w-fit max-w-52 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
            triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            disabled={disabled || pending}
          />
        </span>
        <SubagentReasoningField
          intl={intl}
          state={thoughtLevelState}
          disabled={disabled || pending}
          labelVisibilityClassName="hidden sm:inline-flex"
          onValueCommit={(thoughtLevel) => {
            if (thoughtLevel === config.thoughtLevel) {
              return;
            }
            void persistConfig({ model: config.model, thoughtLevel });
          }}
        />
      </div>
      {thoughtLevelInvalid ? (
        <span className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: thoughtLevelInvalidMessageId })}
        </span>
      ) : null}
    </div>
  );
}
