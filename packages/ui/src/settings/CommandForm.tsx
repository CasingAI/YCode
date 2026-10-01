import { useMemo, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { completeNewModelSelection } from "@zcode/provider";
import type { ModelSelectionView } from "@zcode/services";
import {
  type CommandAgentSource,
  type CommandConfig,
  type ModelSelection,
  type UserCommand,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { CommandModeField, INHERIT_MODE_VALUE } from "@/settings/CommandModeField.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import {
  INHERIT_MODEL_VALUE,
  isOverrideModelAvailable,
  MODEL_OVERRIDE_ITEM_NEVER_LOCKED,
  resolveOverrideModelLabel,
  resolveOverrideThoughtOptionState,
  toOverrideModelSelection,
  toOverrideModelValue,
} from "@/settings/ModelOverrideControl.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SubagentReasoningField } from "@/settings/SubagentReasoningField.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 50;

function CommandFormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1 block text-ui-base font-medium text-foreground-subtle">{children}</label>
  );
}

function CommandScopeMenu({
  disabled,
  scopeKey,
  workspaceTabs,
  onChange,
}: {
  disabled: boolean;
  scopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  onChange: (scopeKey: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const scopeLabel = intl.formatMessage({ id: "settings.scope.label" });

  return (
    <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="shrink-0 text-ui-base text-foreground-subtle">{scopeLabel}</span>
      <PluginScopeMenu
        align="end"
        disabled={disabled}
        selectedScopeKey={scopeKey}
        workspaceTabs={workspaceTabs}
        onScopeKeyChange={onChange}
      />
    </label>
  );
}

export interface CommandFormModelSectionProps {
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionLoading: boolean;
}

interface CommandFormProps {
  initial?: UserCommand;
  agentSource?: CommandAgentSource;
  scopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  onScopeKeyChange: (scopeKey: string) => void;
  onSave: (
    config: CommandConfig,
    scopeKey: string,
    modelSelection: ModelSelection | undefined,
    mode: SubmissionMode | undefined,
    modeTouched: boolean,
  ) => Promise<void>;
  onCancel: () => void;
  onDelete?: (command: UserCommand) => void;
  saving: boolean;
  modelSection?: CommandFormModelSectionProps;
}

export function CommandForm({
  initial,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
  onSave,
  onCancel,
  onDelete,
  saving,
  modelSection,
}: CommandFormProps) {
  const { intl } = useZCodeIntl();
  const supportsArgumentHint = true;
  const initialName = initial?.name?.replace(/^\//, "") ?? "";
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [argumentHint, setArgumentHint] = useState(initial?.argumentHint ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  // 绑定走延迟态：表单内只改本地 state，点保存才随 onSave 一起提交，
  // 取消直接丢弃——与 ModelOverrideControl 的即改即存语义相反。
  const [modelValue, setModelValue] = useState<string | undefined>(() =>
    initial?.modelSelectionOverride
      ? toOverrideModelValue(initial.modelSelectionOverride)
      : undefined,
  );
  const [thoughtLevel, setThoughtLevel] = useState<string | undefined>(
    () => initial?.modelSelectionOverride?.options?.reasoningLevel,
  );
  // 模式绑定走同样的延迟态：表单内只改本地 state，点保存才提交；未动过则不碰文件头 mode 键。
  const [modeValue, setModeValue] = useState<string>(
    () => initial?.modeOverride ?? INHERIT_MODE_VALUE,
  );
  const trimmedName = name.trim();
  const modelGroups: readonly ModelSelectGroup[] = useMemo(() => {
    const view = modelSection?.modelSelectionView;
    if (!view) return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      apiKeyLabel: intl.formatMessage({
        id: "settings.modelProvider.apiKey",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [intl, modelSection?.modelSelectionView]);
  const modelSelectionLoading = modelSection?.modelSelectionLoading ?? true;
  const normalizedModelValue = modelValue ?? INHERIT_MODEL_VALUE;
  const modelAvailable = isOverrideModelAvailable(
    modelGroups,
    normalizedModelValue,
    modelSelectionLoading,
  );
  const thoughtLevelState = resolveOverrideThoughtOptionState({
    model: normalizedModelValue,
    modelAvailable,
    modelSelectionView: modelSection?.modelSelectionView,
    modelSelectionLoading,
    thoughtLevel,
  });
  const modelTriggerLabel =
    normalizedModelValue === INHERIT_MODEL_VALUE
      ? intl.formatMessage({ id: "settings.subagents.model.defaultMain" })
      : resolveOverrideModelLabel({
          inheritLabel: intl.formatMessage({ id: "settings.subagents.model.defaultMain" }),
          modelGroups,
          model: normalizedModelValue,
        });

  const handleModelValueChange = (nextValue: string) => {
    const nextModel = nextValue === INHERIT_MODEL_VALUE ? undefined : nextValue;
    if (nextModel === modelValue) return;
    setModelValue(nextModel);
    if (!nextModel) {
      setThoughtLevel(undefined);
      return;
    }
    // 换模型时补齐该模型的默认档位，与行内控件的落盘语义一致。
    const view = modelSection?.modelSelectionView;
    const completed = view
      ? completeNewModelSelection(view, parseModelPickerValue(nextModel))
      : undefined;
    setThoughtLevel(completed?.options?.reasoningLevel);
  };
  const canSave = Boolean(
    prompt.trim() &&
    (initial ||
      (trimmedName.length >= MIN_NAME_LENGTH &&
        trimmedName.length <= MAX_NAME_LENGTH &&
        NAME_REGEX.test(trimmedName))),
  );

  const validate = (): boolean => {
    let valid = true;
    const trimmedName = name.trim();
    const nameRegex = NAME_REGEX;
    // 命令表单字段曾直接硬编码英文，导致中文界面下校验错误仍显示英文。
    if (initial) {
      setNameError(null);
    } else if (trimmedName.length < MIN_NAME_LENGTH || trimmedName.length > MAX_NAME_LENGTH) {
      setNameError(
        intl.formatMessage(
          { id: "settings.commands.form.validation.nameLength" },
          {
            min: String(MIN_NAME_LENGTH),
            max: String(MAX_NAME_LENGTH),
          },
        ),
      );
      valid = false;
    } else if (!nameRegex.test(trimmedName)) {
      setNameError(
        intl.formatMessage({
          id: "settings.commands.form.validation.nameCharacters",
        }),
      );
      valid = false;
    } else {
      setNameError(null);
    }
    if (!prompt.trim()) {
      setPromptError(
        intl.formatMessage({
          id: "settings.commands.form.validation.promptRequired",
        }),
      );
      valid = false;
    } else {
      setPromptError(null);
    }
    return valid;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    const config: CommandConfig = {
      name: name.trim(),
      prompt: prompt.trim(),
      description: description.trim() || undefined,
      argumentHint: supportsArgumentHint ? argumentHint.trim() || undefined : undefined,
    };
    // 新建命令没有可继承的旧绑定：表单选了模型即新绑定，未选即无绑定。
    // 编辑命令：未动模型区（仍等于 initial 绑定）即 undefined，调用方跳过覆盖写，
    // 避免表单保存重写文件头时丢掉行外改过的绑定。
    const nextSelection = toOverrideModelSelection(
      normalizedModelValue === INHERIT_MODEL_VALUE ? undefined : normalizedModelValue,
      thoughtLevel,
    );
    // 模式绑定同样的两步语义：新建时选了即新绑定；编辑时未动（仍等于 initial）
    // 则调用方跳过 mode 键的覆盖写，避免洗掉行外改过的值。
    const initialMode = initial?.modeOverride ?? INHERIT_MODE_VALUE;
    const nextMode: SubmissionMode | undefined =
      modeValue === INHERIT_MODE_VALUE ? undefined : (modeValue as SubmissionMode);
    const modeTouched = initial ? modeValue !== initialMode : nextMode !== undefined;
    await onSave(config, scopeKey, nextSelection, nextMode, modeTouched);
  };
  const scopeSelect = (
    <CommandScopeMenu
      disabled={Boolean(initial)}
      scopeKey={scopeKey}
      workspaceTabs={workspaceTabs}
      onChange={onScopeKeyChange}
    />
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="w-full min-w-0 space-y-1.5 md:w-48">
          <CommandFormFieldLabel>
            {intl.formatMessage({ id: "settings.commands.form.name.label" })}
          </CommandFormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.commands.form.name.placeholder",
            })}
            disabled={!!initial}
          />
        </div>
        <div>{scopeSelect}</div>
      </div>
      {nameError ? <p className="-mt-1 text-ui-base text-destructive">{nameError}</p> : null}

      <div className="space-y-1.5">
        <CommandFormFieldLabel>
          {intl.formatMessage({
            id: "settings.commands.form.description.label",
          })}
        </CommandFormFieldLabel>
        <Input
          type="text"
          size="lg"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.commands.form.description.placeholder",
          })}
        />
      </div>

      {supportsArgumentHint ? (
        <div className="space-y-1.5">
          <CommandFormFieldLabel>
            {intl.formatMessage({
              id: "settings.commands.form.argumentHint.label",
            })}
          </CommandFormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={argumentHint}
            onChange={(event) => setArgumentHint(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.commands.form.argumentHint.placeholder",
            })}
          />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <CommandFormFieldLabel>
          {intl.formatMessage({ id: "settings.commands.form.prompt.label" })}
        </CommandFormFieldLabel>
        <SettingsFormTextarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          className="min-h-28 text-ui-base"
          placeholder={intl.formatMessage({
            id: "settings.commands.form.prompt.placeholder",
          })}
        />
        {promptError ? <p className="text-ui-base text-destructive">{promptError}</p> : null}
      </div>

      {modelSection ? (
        <div className="space-y-1.5">
          <CommandFormFieldLabel>
            {intl.formatMessage({ id: "settings.commands.form.model.label" })}
          </CommandFormFieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <ModelConfigSelect
              modelGroups={modelGroups}
              normalizedValue={normalizedModelValue}
              triggerLabel={modelTriggerLabel}
              showManageModelsAction={false}
              lockReasonMessage=""
              isItemLocked={MODEL_OVERRIDE_ITEM_NEVER_LOCKED}
              onValueChange={handleModelValueChange}
              footerActions={[
                {
                  key: "command-form:model-inherit",
                  label: intl.formatMessage({ id: "settings.subagents.model.defaultMain" }),
                  onSelect: () => handleModelValueChange(INHERIT_MODEL_VALUE),
                  selected: normalizedModelValue === INHERIT_MODEL_VALUE,
                },
              ]}
              manageModelsLabel={intl.formatMessage({ id: "chat.toolbar.model.manageModels" })}
              contentSide="bottom"
              contentAlign="start"
              focusSelectorOnClose={null}
              // 设置页祖先链上没有 @container/composer，组件默认的
              // labelVisibilityClassName（hidden @xl/composer:inline-flex）会让
              // 标签恒隐藏、触发器只剩一个下箭头；与 Subagents 表单同款显式展示。
              labelVisibilityClassName="inline-flex min-w-0"
              triggerClassName="h-8 w-fit max-w-full min-w-0 justify-between rounded-lg border border-input-border bg-input bg-clip-border px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
              triggerLabelClassName="inline-flex min-w-0 truncate text-left"
              disabled={saving}
            />
            <SubagentReasoningField
              intl={intl}
              state={thoughtLevelState}
              disabled={saving}
              labelVisibilityClassName="hidden sm:inline-flex"
              onValueCommit={setThoughtLevel}
            />
          </div>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.commands.form.model.hint" })}
          </p>
        </div>
      ) : null}

      <CommandModeField value={modeValue} onChange={setModeValue} disabled={saving} />

      <SettingsFormActions
        leadingAction={
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button type="submit" variant="default" size="lg" disabled={!canSave || saving}>
          {saving
            ? intl.formatMessage({ id: "common.saving" })
            : intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={saving}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </form>
  );
}
