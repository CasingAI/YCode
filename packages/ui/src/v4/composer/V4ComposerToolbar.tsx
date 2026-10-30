/* oxlint-disable eslint(max-lines) -- V4ComposerToolbar 汇聚模型/思考深度/context usage 三件套；继续拆分会打散工具条热键与模型目录 memo 的共享状态。 */
/**
 * V4 composer 工具条。
 *
 * 展示件全部复用旧 chat-input-toolbar 的纯 props 组件（ModelConfigSelect /
 * ChatModeSwitchControl / ThoughtLevelCycleControl / ChatContextUsage），外观与旧
 * ChatInputToolbar 对齐；但状态编排是全新 v4 wiring，不复活旧 ChatInputToolbar 的
 * effect 链 / 旧协议写路径：
 * - 当前模型/档位来自 Composer；已运行会话的用量来自 snapshot.usage.contextWindow
 * - 模型、思考深度和模式只更新下一次 Submission 的 Composer 意图
 * - 模型静态事实来自目标 Host ModelSelectionView；workspace configOptions 只提供
 *   mode 等非模型 presentation
 *
 * 新任务和已有会话采用相同的 Composer 显示事实；prewarm 不补模型或档位。
 * 提交时由宿主（SessionPane）把冻结选择随 Submission 一起发送。
 * 三件套不能全部门控在 config!==null 上——草稿态会整体不渲染。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isCliProxyProviderTemplateId,
  isCommandCodeProviderTemplateId,
  isDeepSeekProviderTemplateId,
  isMiniMaxTokenPlanProviderTemplateId,
  isOpenCodeGoProviderTemplateId,
  isOpenCodeZenProviderTemplateId,
  isOpenRouterProviderTemplateId,
  TID_V4_MODEL_CONFIG,
  TID_V4_COMPOSER_INPUT,
  ZCODE_AGENT_PROVIDER,
  type ZCodeConfigOption,
  type ZCodeProvider,
} from "@zcode/shared";
import type {
  SessionConfigState,
  SessionPhase,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { Button } from "@/components/ui/button.js";
import type { ChatCliProxyQuotaConfig } from "@/chat-input-toolbar/CliProxyContextUsage.js";
import { ChatContextUsage } from "@/chat-input-toolbar/display.js";
import {
  hasChatZhipuQuota,
  type ChatZhipuQuotaConfig,
} from "@/chat-input-toolbar/ZhipuContextQuota.js";
import { isZhipuTemplateId } from "@/settings/model-provider-section/ZhipuTemplateQuotaSection.js";
import type { ChatDeepSeekBalanceConfig } from "@/chat-input-toolbar/DeepSeekContextUsage.js";
import type { ChatOpenCodeUsageConfig } from "@/chat-input-toolbar/OpenCodeContextUsage.js";
import type { ChatMiniMaxQuotaConfig } from "@/chat-input-toolbar/MiniMaxContextUsage.js";
import type { ChatCommandCodeQuotaConfig } from "@/chat-input-toolbar/CommandCodeContextUsage.js";
import type { ChatOpenRouterBalanceConfig } from "@/chat-input-toolbar/OpenRouterContextUsage.js";
import type { ChatOpenCodeZenBalanceConfig } from "@/chat-input-toolbar/OpenCodeZenContextUsage.js";

import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import type { ThoughtTriggerVariant } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { getNextThoughtLevelValue } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
import {
  resolveModelSelectTriggerDisplay,
  shouldShowManageModelsAction,
} from "@/chat-input-toolbar/modelSelection.js";
import {
  resolveV4ModelTriggerDisplay,
  formatModelChangeLabel,
} from "@/v4/composer/modelTriggerDisplay.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import { toast } from "@/components/ui/toast.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useSettings } from "@/hooks/useSettingService.js";

import { useToolbarConfigOptions } from "@/hooks/useZCodeConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";

import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import {
  buildRegistryModelSelectGroups,
  decodeModelGroupSelectValue,
  encodeModelGroupSelectValue,
  resolveModelGroupDisplayName,
  withModelGroupSection,
} from "@/lib/modelSelectionGroups.js";

import {
  resolveDraftDisplayedConfig,
  resolveDraftModelThoughtOption,
  resolveDraftThoughtCurrentValue,
} from "@/v4/composer/draftWorkspaceDefaults.js";

// 拆分件再导出（模式选择移居 V4ComposerModeControls，超行数拆分）：
// 既有消费方（ConversationComposer）继续从本模块入口 import，接口面不变。
export { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";

const V4_COMPOSER_INPUT_SELECTOR = `[data-testid="${TID_V4_COMPOSER_INPUT}"]`;
const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

/** 稳定空回调（热键 hook 单实例只处理本组件拥有的选项，其余动作占位）。 */
function noop(): void {}

export interface ModelSelectionSource {
  provider: string;
  model: string;
}

// 智谱剥离：account:*/codingPlan/teamPlan/startPlan 套餐连接判定已删除
//（见 docs/specs/zhipu-special-removal.md）。composer 额度只按选中 provider 的
// templateId 挂载（智谱模板走 ZhipuContextQuota，其余走既有 OpenCode/DeepSeek 等分支）。
export interface V4ComposerToolbarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  modelSelectionReload?: () => void;
  sessionId: string | null;
  phase: SessionPhase | null;
  provider?: ZCodeProvider;
  /** 当前工具条是否运行在 Web 远控壳中。 */
  /** 当前视口是否为手机输入布局。 */
  isMobileViewport?: boolean;
  /** 草稿态（sessionId=null），仅区分新任务呈现，不改变选择来源。 */
  draftMode?: boolean;
  /** 当前 scope 的 Composer 选择；新任务与已有会话都只显示这份状态。 */
  draftConfig?: Partial<SessionConfigState>;
  usage: SessionUsageState | null;
  disabled: boolean;
  /**
   * true = 本实例的工具条热键（Ctrl+M / Ctrl+Shift+M / Ctrl+T）整体下线。
   * 主 composer 在行内编辑卡打开时置位，让位给编辑卡内同款控件注册的热键；
   * 编辑卡自己的控件不传（默认 false），行为零变化。
   */
  hotkeysSuppressed?: boolean;
  /** 单个 composer 内的配置 picker 排他 owner；只属于 renderer-local presentation。 */
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  /**
   * 选中模型（providerId/modelId 来自目录 value 解码），由 Composer owner 更新并持久化。
   * sourceModel 只表达这次用户操作的来源，不从 Session 投影补 CAS 或思考档位。
   */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
  ) => void;
  /**
   * 选中模型组（docs/specs/model-group.md）：owner 写组意图并清具体选择。
   * groupName 取菜单当下的组名做快照；组已删的候选不会出现在菜单里。
   * 必填：菜单里出现组条目就必须有消费方——可选回调会让「点了没反应」变成
   * 静默失败（菜单照常关闭、状态不变），死可供性就是这么来的。
   */
  onSelectModelGroup: (groupId: string, groupName: string) => void;
  /** 选中思考深度；modelContext 固定本次用户操作的目标模型。 */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** prepare/configOptions 失败时，custom provider 选择走 workspace recovery 链。 */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  onSendCompressionCommand?: (command: string) => void;
  /**
   * 复用方（行内编辑卡）传 true：跳过隐藏的 TID_V4_MODEL_CONFIG e2e 锚点，
   * 避免编辑卡打开期间同一 testid 在 DOM 出现两份。
   */
  hideConfigAnchor?: boolean;
  /**
   * 复用方（行内编辑卡）传 true：模型 trigger 恒为图标态（隐藏 provider/model
   * 文字标签与下拉箭头，只留包图标），为窄卡工具条省横向空间；完整名称保留在
   * tooltip 与菜单里，选择功能不变。主 composer 不传，行为零变化。
   */
  forceCompactModelTrigger?: boolean;
  /**
   * 复用方（行内编辑卡）传 "levelBar"：思考控件钉死「灯塔 + 档位竖条」形态，
   * 任何宽度都不出现文字与箭头（docs/specs/composer-edit-thought-level-bar.md）。
   * 主 composer 不传（默认 "toolbar"），自适应行为零变化。
   */
  thoughtVariant?: ThoughtTriggerVariant;
}

/** 模型 / 思考深度 / context usage 簇（渲染在发送键左侧，与旧 UI 同位）。 */
function V4ComposerModelControlsImpl({
  workspacePath,
  workspaceIdentity,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  provider,
  isMobileViewport = false,
  draftMode = false,
  draftConfig,
  usage,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectModel,
  onSelectModelGroup,
  onSelectThought,
  onSendCompressionCommand,
  onRecoverCustomModelSelection,
  hideConfigAnchor = false,
  forceCompactModelTrigger = false,
  thoughtVariant = "toolbar",
  hotkeysSuppressed = false,
}: V4ComposerToolbarProps) {
  const { intl, locale } = useZCodeIntl();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  // 配置面读取：workspace 缺省目录（taskId=null），不读旧会话态。
  const { error: configOptionsError } = useToolbarConfigOptions(
    workspacePath,
    null,
    workspaceIdentity,
  );
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  void providerSettingsView;
  void providerSourcesLoading;
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const modelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // Ctrl+M 热键：递增 openRequestKey 请求 ModelConfigSelect 打开菜单（旧 handleOpenModelMenuShortcut 语义）。
  const [modelMenuOpenRequestKey, setModelMenuOpenRequestKey] = useState(0);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const handleOpenModelMenuShortcut = useCallback(() => {
    setModelMenuOpenRequestKey((current) => current + 1);
  }, []);
  const handleModelPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("model", open);
    },
    [onConfigPickerOpenChange],
  );
  const handleThoughtPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("thought", open);
    },
    [onConfigPickerOpenChange],
  );

  const modelOption = modelSelectionView?.providers.some((provider) => provider.models.length > 0)
    ? ({
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "",
        options: [],
      } satisfies ZCodeConfigOption)
    : undefined;

  // 空模型/档位曾被 Session 旧值补回，界面显示与实际不可提交状态矛盾。
  // 初始化已经由 Composer owner 完成；显示层只消费它，不能再次补值。
  const effectiveConfig = useMemo<SessionConfigState | null>(() => {
    return resolveDraftDisplayedConfig(draftConfig ?? {});
  }, [draftConfig]);

  // 高频交互排障只走 debug，避免生产日志量随每次选择增长。
  useEffect(() => {
    if (!draftMode) return;
    logger.debug("[v4-toolbar] draft effectiveConfig changed", {
      provider: effectiveConfig?.provider ?? null,
      model: effectiveConfig?.model ?? null,
      thought: effectiveConfig?.thought ?? null,
      modelSelectionRevision: modelSelectionView?.revision ?? null,
    });
  }, [draftMode, effectiveConfig, modelSelectionView?.revision]);

  const modelSelectGroups = useMemo<ModelSelectGroup[]>(() => {
    if (!modelSelectionView) return [];
    const registryGroups = buildRegistryModelSelectGroups(displayProvider, modelSelectionView, {
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      apiKeyBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.apiKeyBadge",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
      codingPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlanBadge",
      }),
      startPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlan",
      }),
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      teamPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlanBadge",
      }),
      teamPlanFallbackLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlan",
      }),
      otherGroupLabel: intl.formatMessage({ id: "chat.toolbar.model.otherGroup" }),
    });
    // 模型组分节（docs/specs/model-group.md）：registry 分组 + 组分节的唯一拼装入口
    // 在 withModelGroupSection；整节 Primary（view.modelGroupsPrimary）时组逐条置顶一级展开。
    return withModelGroupSection({
      registryGroups,
      view: modelSelectionView,
      groupSectionLabel: intl.formatMessage({ id: "chat.toolbar.model.groupSection" }),
    });
  }, [displayProvider, intl, modelSelectionView]);

  // 修复：恢复「管理模型」入口（老版 onManageModels = 打开设置页并定位模型供应商区）。
  const handleOpenModelProviderSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const showManageModelsAction = shouldShowManageModelsAction(handleOpenModelProviderSettings);
  const manageModelsLabel = intl.formatMessage({
    id: "chat.toolbar.model.manageModels",
  });

  // OpenCode Go provider（opencode-go-* 模板）没有官方 entitlement 链路，composer 额度入口
  // 改走 OpenCode 用量服务；按选中 provider 实例的 templateId 判定是否展示。
  // Zen（opencode-zen-*）按量付费没有套餐窗口，不走本配置，改走 openCodeZenBalanceConfig。
  const openCodeUsageConfig = useMemo<ChatOpenCodeUsageConfig | undefined>(() => {
    const selectedProviderId = effectiveConfig?.provider?.trim();
    if (!selectedProviderId) {
      return undefined;
    }
    const selected = modelSelectionView?.providers.find(
      (candidate) => candidate.providerId === selectedProviderId,
    );
    if (!isOpenCodeGoProviderTemplateId(selected?.templateId)) {
      return undefined;
    }
    return {
      providerId: selectedProviderId,
      configRevision: modelSelectionView?.revision,
      onManage: handleOpenModelProviderSettings,
    };
  }, [effectiveConfig?.provider, handleOpenModelProviderSettings, modelSelectionView]);

  // CLI Proxy provider（cliproxy-* 模板，首批 Codex）：composer 额度环走 CLI Proxy
  // 额度服务（被动观测，浮层展开才拉取）；按选中 provider 实例的 templateId 判定是否展示。
  const cliProxyQuotaConfig = useMemo<ChatCliProxyQuotaConfig | undefined>(() => {
    const selectedProviderId = effectiveConfig?.provider?.trim();
    if (!selectedProviderId) {
      return undefined;
    }
    const selected = modelSelectionView?.providers.find(
      (candidate) => candidate.providerId === selectedProviderId,
    );
    if (!isCliProxyProviderTemplateId(selected?.templateId)) {
      return undefined;
    }
    return {
      providerId: selectedProviderId,
      onManage: handleOpenModelProviderSettings,
    };
  }, [effectiveConfig?.provider, handleOpenModelProviderSettings, modelSelectionView]);

  // DeepSeek provider（deepseek 模板）没有套餐额度，composer 额度入口展示官方账户余额；
  // 同样按选中 provider 实例的 templateId 判定是否展示。
  const deepSeekBalanceConfig = useMemo<ChatDeepSeekBalanceConfig | undefined>(() => {
    const selectedProviderId = effectiveConfig?.provider?.trim();
    if (!selectedProviderId) {
      return undefined;
    }
    const selected = modelSelectionView?.providers.find(
      (candidate) => candidate.providerId === selectedProviderId,
    );
    if (!isDeepSeekProviderTemplateId(selected?.templateId)) {
      return undefined;
    }
    return {
      providerId: selectedProviderId,
      onManage: handleOpenModelProviderSettings,
    };
  }, [effectiveConfig?.provider, handleOpenModelProviderSettings, modelSelectionView]);

  // MiniMax Token Plan（minimax-token-plan 模板）composer 额度入口：查双窗口剩余额度。
  const minimaxQuotaConfig = useMemo<ChatMiniMaxQuotaConfig | undefined>(() => {
    const selectedProviderId = effectiveConfig?.provider?.trim();
    if (!selectedProviderId) {
      return undefined;
    }
    const selected = modelSelectionView?.providers.find(
      (candidate) => candidate.providerId === selectedProviderId,
    );
    if (!isMiniMaxTokenPlanProviderTemplateId(selected?.templateId)) {
      return undefined;
    }
    return {
      providerId: selectedProviderId,
      onManage: handleOpenModelProviderSettings,
    };
  }, [effectiveConfig?.provider, handleOpenModelProviderSettings, modelSelectionView]);

  // OpenRouter（openrouter 模板）composer 额度入口：查账户积分余额。
  const openRouterBalanceConfig = useMemo<ChatOpenRouterBalanceConfig | undefined>(() => {
    const selectedProviderId = effectiveConfig?.provider?.trim();
    if (!selectedProviderId) {
      return undefined;
    }
    const selected = modelSelectionView?.providers.find(
      (candidate) => candidate.providerId === selectedProviderId,
    );
    if (!isOpenRouterProviderTemplateId(selected?.templateId)) {
      return undefined;
    }
    return {
      providerId: selectedProviderId,
      onManage: handleOpenModelProviderSettings,
    };
  }, [effectiveConfig?.provider, handleOpenModelProviderSettings, modelSelectionView]);

  // Command Code（commandcode 模板）composer 额度入口：查套餐双窗口额度与余额。
  const commandCodeQuotaConfig = useMemo<ChatCommandCodeQuotaConfig | undefined>(() => {
    const selectedProviderId = effectiveConfig?.provider?.trim();
    if (!selectedProviderId) {
      return undefined;
    }
    const selected = modelSelectionView?.providers.find(
      (candidate) => candidate.providerId === selectedProviderId,
    );
    if (!isCommandCodeProviderTemplateId(selected?.templateId)) {
      return undefined;
    }
    return {
      providerId: selectedProviderId,
      onManage: handleOpenModelProviderSettings,
    };
  }, [effectiveConfig?.provider, handleOpenModelProviderSettings, modelSelectionView]);

  // OpenCode Zen（opencode-zen-* 模板）composer 额度入口：查 billing 余额。
  const openCodeZenBalanceConfig = useMemo<ChatOpenCodeZenBalanceConfig | undefined>(() => {
    const selectedProviderId = effectiveConfig?.provider?.trim();
    if (!selectedProviderId) {
      return undefined;
    }
    const selected = modelSelectionView?.providers.find(
      (candidate) => candidate.providerId === selectedProviderId,
    );
    if (!isOpenCodeZenProviderTemplateId(selected?.templateId)) {
      return undefined;
    }
    return {
      providerId: selectedProviderId,
      configRevision: modelSelectionView?.revision,
      onManage: handleOpenModelProviderSettings,
    };
  }, [effectiveConfig?.provider, handleOpenModelProviderSettings, modelSelectionView]);

  // 智谱模板自建 provider（zai-api/bigmodel-api/zai-standard-api/bigmodel-standard-api）
  // composer 额度入口：用自存 Coding Plan Key 直查 quota/limit 剩余额度。
  const zhipuQuotaConfig = useMemo<ChatZhipuQuotaConfig | undefined>(() => {
    const selectedProviderId = effectiveConfig?.provider?.trim();
    if (!selectedProviderId) {
      return undefined;
    }
    const selected = modelSelectionView?.providers.find(
      (candidate) => candidate.providerId === selectedProviderId,
    );
    if (!isZhipuTemplateId(selected?.templateId)) {
      return undefined;
    }
    return {
      providerId: selectedProviderId,
      onManage: handleOpenModelProviderSettings,
    };
  }, [effectiveConfig?.provider, handleOpenModelProviderSettings, modelSelectionView]);

  // 当前投影模型的编码值：provider 命中目录则按自定义模型编码，否则回落裸 model id。
  const rawModelValue = useMemo(() => {
    if (!effectiveConfig || !effectiveConfig.model) return "";
    const providerExists = modelSelectionView?.providers.some(
      (candidate) => candidate.providerId === effectiveConfig.provider,
    );
    if (providerExists) {
      return encodeCustomModelValue(effectiveConfig.provider, effectiveConfig.model);
    }
    return effectiveConfig.model;
  }, [effectiveConfig, modelSelectionView]);

  // 组意图草稿（docs/specs/model-group.md）：胶囊按组名展示——组还在读当前名，
  // 已删用名快照；菜单选中态落在对应组条目上。
  const draftGroupIntent = draftConfig?.modelGroupIntent ?? null;
  const selectedModelGroupValue = draftGroupIntent
    ? encodeModelGroupSelectValue(draftGroupIntent.groupId)
    : null;
  const selectedModelGroupView = useMemo(
    () =>
      draftGroupIntent
        ? ((modelSelectionView?.modelGroups ?? []).find(
            (group) => group.groupId === draftGroupIntent.groupId,
          ) ?? null)
        : null,
    [draftGroupIntent, modelSelectionView],
  );

  // 触发器显示兜底——`<synthetic>`（Claude SDK 恢复合成模型）或当前模型
  // 不在可选组（失效/下线/退登）→ 回落占位/默认「选择模型」，不直显协议内部占位符或失效
  // 模型 id。复用存活的 resolveModelSelectTriggerDisplay。
  const triggerDisplay = useMemo(
    () =>
      resolveModelSelectTriggerDisplay(
        rawModelValue,
        modelSelectGroups,
        showManageModelsAction,
        manageModelsLabel,
      ),
    [manageModelsLabel, modelSelectGroups, rawModelValue, showManageModelsAction],
  );
  const normalizedModelValue = draftGroupIntent
    ? selectedModelGroupValue!
    : (triggerDisplay.value ?? "");

  const modelTriggerDisplay = useMemo(() => {
    // 组意图（docs/specs/model-group.md）：胶囊整名展示组名，不带 provider 前缀；
    // 组已被删除时按名快照展示（spec：不为文案编造新名字，也不退回「选择模型」）。
    if (draftGroupIntent) {
      // 组名回填规则与命令中心副文案共用 resolveModelGroupDisplayName：当前视图名优先，
      // 组已删时按名快照展示（spec：不为文案编造新名字，也不退回「选择模型」）。
      const groupName =
        resolveModelGroupDisplayName(modelSelectionView, draftGroupIntent) ??
        draftGroupIntent.groupNameSnapshot;
      return { fullLabel: groupName, modelLabel: groupName };
    }
    // 非可选值（未选 / synthetic / 不可用）：占位文案或默认「选择模型」。
    const fallbackLabel =
      triggerDisplay.placeholder ?? intl.formatMessage({ id: "chat.toolbar.model.label" });
    const providerName =
      modelSelectionView?.providers.find(
        (candidate) => candidate.providerId === effectiveConfig?.provider,
      )?.providerName ?? undefined;
    return resolveV4ModelTriggerDisplay({
      modelGroups: modelSelectGroups,
      normalizedValue: normalizedModelValue,
      fallbackLabel,
      providerId: effectiveConfig?.provider,
      providerName,
    });
  }, [
    draftGroupIntent,
    effectiveConfig?.provider,
    intl,
    modelSelectionView,
    modelSelectGroups,
    normalizedModelValue,
    selectedModelGroupView,
    triggerDisplay.placeholder,
  ]);
  const handleModelValueChange = useCallback(
    (value: string) => {
      // 组条目（docs/specs/model-group.md）：值编码 model-group:<groupId>，先于
      // provider/model 解码分支拦截；组名以菜单当下视图为准（快照由 owner 侧兜底）。
      const groupId = decodeModelGroupSelectValue(value);
      if (groupId !== null) {
        const groupName =
          (modelSelectionView?.modelGroups ?? []).find((group) => group.groupId === groupId)
            ?.name ?? groupId;
        onSelectModelGroup(groupId, groupName);
        return;
      }
      const decoded = decodeCustomModelValue(value);
      // 草稿的点击时可见模型可能只存在于 catalog，或已经被最新 draft
      // intent 覆盖，不能让 SessionPane 再从迟到的 prewarm projection 反推。
      const sourceModel =
        effectiveConfig?.provider && effectiveConfig.model
          ? {
              provider: effectiveConfig.provider,
              model: effectiveConfig.model,
            }
          : null;
      // debug 日志（草稿态切模型排障）：点击值 + 解码分支。
      logger.debug("[v4-toolbar] model select onValueChange", {
        value,
        decodedProviderId: decoded?.providerId ?? null,
        decodedModelName: decoded?.modelName ?? null,
        draftMode,
      });
      const selectedRegistryProvider = decoded?.providerId
        ? modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )
        : undefined;
      const customRecoveryEligible = isApiKeyAccess(selectedRegistryProvider?.config.access);
      if (
        configOptionsError &&
        decoded?.providerId &&
        customRecoveryEligible &&
        onRecoverCustomModelSelection
      ) {
        setRecoveryPending(true);
        // 恢复函数收口全部预期失败（失败提示由恢复函数自己弹）；
        // 这里只兜真正意外的拒绝（恢复函数抛出的非预期错误），同样弹失败提示，
        // 避免恢复链任一环节失败都只剩灰锁、用户干等。
        void Promise.resolve(onRecoverCustomModelSelection(value, sourceModel))
          .catch((error) => {
            logger.warn("[v4-toolbar] custom provider recovery failed", {
              error: error instanceof Error ? error.message : String(error),
              providerId: decoded.providerId,
            });
            toast(
              intl.formatMessage(
                { id: "chat.modelChangeNotice.recoveryFailed" },
                {
                  toModel: formatModelChangeLabel(
                    decoded.providerId,
                    resolveProviderLabel(decoded.providerId, modelSelectionView),
                    decoded.modelName ?? value,
                    intl,
                  ),
                },
              ),
            );
          })
          .finally(() => {
            setRecoveryPending(false);
          });
        return;
      }
      if (decoded) {
        onSelectModel(decoded.providerId, decoded.modelName ?? "", sourceModel);
        return;
      }
      const slashIndex = value.indexOf("/");
      if (slashIndex > 0) {
        onSelectModel(value.slice(0, slashIndex), value.slice(slashIndex + 1), sourceModel);
        return;
      }
      // 裸 model id：provider 沿用当前（宿主从最新投影补齐）。
      onSelectModel("", value, sourceModel);
    },
    [
      configOptionsError,
      displayProvider,
      draftMode,
      effectiveConfig?.model,
      effectiveConfig?.provider,
      onRecoverCustomModelSelection,
      onSelectModel,
      onSelectModelGroup,
      modelSelectionView,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const draftModelThoughtOption = useMemo(
    () =>
      effectiveConfig
        ? resolveDraftModelThoughtOption(
            effectiveConfig.provider,
            effectiveConfig.model,
            modelSelectionView,
          )
        : null,
    [effectiveConfig, modelSelectionView],
  );

  // 候选档位只来自目标 Host 的 ModelSelectionView，已选档位只来自 Composer。
  const thoughtOption = useMemo<ZCodeConfigOption | null>(() => {
    if (!effectiveConfig) return null;
    if (!draftModelThoughtOption) return null;
    return {
      ...draftModelThoughtOption,
      currentValue: resolveDraftThoughtCurrentValue({
        thought: effectiveConfig.thought,
        thoughtLevels: draftModelThoughtOption.options?.map((option) => option.value) ?? [],
      }),
    };
  }, [draftModelThoughtOption, effectiveConfig]);

  const handleThoughtValueChange = useCallback(
    (value: string) => {
      if (!effectiveConfig) return;
      if (!value.trim()) {
        // 跨模型受控 Select 重建时可能抛出一次空 value；它不是用户选择，
        // 若继续上抛会把模型 intent 标成 superseded，导致 accepted 模型无法写入全局元组。
        logger.debug("[v4-toolbar] ignore synthetic empty thought change", {
          model: effectiveConfig.model,
          provider: effectiveConfig.provider,
        });
        return;
      }
      onSelectThought(value, {
        provider: effectiveConfig.provider,
        model: effectiveConfig.model,
      });
    },
    [effectiveConfig, onSelectThought],
  );

  // Ctrl+T 热键：按目录顺序循环下一次 Submission 的思考深度。
  const handleCycleThoughtLevel = useCallback(() => {
    if (!thoughtOption || thoughtOption.type !== "select") {
      return;
    }
    const nextValue = getNextThoughtLevelValue(thoughtOption);
    if (nextValue == null) {
      return;
    }
    if (!effectiveConfig) return;
    onSelectThought(nextValue, {
      provider: effectiveConfig.provider,
      model: effectiveConfig.model,
    });
  }, [effectiveConfig, onSelectThought, thoughtOption]);

  const taskUsage = useMemo(() => {
    const contextWindow = usage?.contextWindow;
    if (!contextWindow) return null;
    return {
      used: contextWindow.usedTokens,
      size: contextWindow.maxTokens,
      ...(contextWindow.cache ? { cache: contextWindow.cache } : {}),
      ...(contextWindow.breakdown ? { breakdown: contextWindow.breakdown } : {}),
    };
  }, [usage?.contextWindow]);
  // 工具条热键已转正为命令表命令：tooltip 快捷键文案读生效表，
  // 改绑后按钮提示即时跟随（不能用硬编码文案）。
  const modelShortcutLabel = useShortcutCommandLabel("openModelMenu");
  const thoughtShortcutLabel = useShortcutCommandLabel("cycleThoughtLevel");
  const isModelOptionLocked = useCallback(() => false, []);

  // 键盘热键（旧 useToolbarShortcutBindings）：Ctrl+M 打开模型菜单、Ctrl+T 循环思考深度。
  // 模式循环（Ctrl+Shift+M）由 V4ComposerModeSwitch 单独绑定（modeOption 在彼处）。
  // 模型留空是正常的待选择状态，包括已有会话；不能因为没有已选模型隐藏重选入口。
  // 有可选组时正常显示；无组但有「管理模型」入口时也显示，避免用户零模型入口。
  const modelMenuVisible = modelSelectGroups.length > 0 || showManageModelsAction;
  const providerSubmenuClassName = undefined;
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(modelOption) || Boolean(thoughtOption),
    toolbarDisabled: disabled || recoveryPending,
    modelMenuDisabled: disabled || recoveryPending || !modelMenuVisible,
    modelOption,
    thoughtOption: thoughtOption ?? undefined,
    // 编辑卡打开时主 composer 热键让位（Ctrl+M / Ctrl+T 由编辑卡控件接管）。
    suppressed: hotkeysSuppressed,
    onOpenModelMenu: handleOpenModelMenuShortcut,
    onCycleThoughtLevel: handleCycleThoughtLevel,
    onCycleSessionMode: noop,
  });

  return (
    <>
      {/*
        e2e 契约（TID_V4_MODEL_CONFIG）：Composer/usage 状态的 data-* 属性锚点。
        跨模型切换会主动清除源模型的显式 thought；此时可见控件已按目标模型
        Option Spec 展示默认档位，但旧锚点仍暴露空的原始投影。data-thought 必须与用户
        实际看到的受控值一致，不能重新引入一份草稿状态。
      */}
      {hideConfigAnchor ? null : (
        <span
          data-testid={TID_V4_MODEL_CONFIG}
          data-source={effectiveConfig || draftConfig?.mode ? "composer" : ""}
          data-provider={effectiveConfig?.provider ?? ""}
          data-model={effectiveConfig?.model ?? ""}
          data-thought={
            thoughtOption?.type === "select"
              ? String(thoughtOption.currentValue ?? "")
              : (effectiveConfig?.thought ?? "")
          }
          data-thought-levels={
            thoughtOption?.type === "select"
              ? (thoughtOption.options ?? []).map((option) => option.value).join(",")
              : ""
          }
          data-mode={draftConfig?.mode ?? ""}
          data-plan-enabled={draftConfig?.mode === "plan"}
          data-readonly-enabled={draftConfig?.mode === "readonly"}
          data-usage-used={usage?.contextWindow?.usedTokens ?? ""}
          data-usage-max={usage?.contextWindow?.maxTokens ?? ""}
          className="hidden"
        />
      )}
      <ChatContextUsage
        taskUsage={taskUsage}
        zhipuQuota={zhipuQuotaConfig}
        openCodeUsage={openCodeUsageConfig}
        cliProxyQuota={cliProxyQuotaConfig}
        deepSeekBalance={deepSeekBalanceConfig}
        minimaxQuota={minimaxQuotaConfig}
        commandCodeQuota={commandCodeQuotaConfig}
        openRouterBalance={openRouterBalanceConfig}
        openCodeZenBalance={openCodeZenBalanceConfig}
        selectedProvider={displayProvider}
        intl={intl}
        locale={locale}
        onSendCompressionCommand={onSendCompressionCommand}
        compressionDisabled={disabled || recoveryPending}
      />
      {modelSelectionState.status === "error" && modelSelectionReload ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm text-destructive"
          onClick={modelSelectionReload}
        >
          {intl.formatMessage({ id: "chat.toolbar.model.loadFailedRetry" })}
        </Button>
      ) : modelSelectionState.status === "unavailable" ? (
        <span className="px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id:
              modelSelectionState.reason === "remote-waiting"
                ? "chat.toolbar.model.remoteWaiting"
                : "chat.toolbar.model.targetMissing",
          })}
        </span>
      ) : modelMenuVisible ? (
        <ModelConfigSelect
          modelGroups={modelSelectGroups}
          normalizedValue={normalizedModelValue}
          triggerLabel={modelTriggerDisplay.fullLabel}
          triggerLabelPrefix={modelTriggerDisplay.providerPrefix}
          triggerLabelValue={modelTriggerDisplay.modelLabel}
          triggerLabelPrefixClassName={
            forceCompactModelTrigger
              ? "hidden"
              : "composer-provider-prefix hidden @2xl/composer:inline group-data-[composer-provider-compact=true]/toolbar:hidden"
          }
          showManageModelsAction={showManageModelsAction}
          manageModelsLabel={manageModelsLabel}
          onManageModels={handleOpenModelProviderSettings}
          lockReasonMessage={intl.formatMessage({
            id: "chat.toolbar.modelSwitch.lockedByRunningTask",
          })}
          isItemLocked={isModelOptionLocked}
          onValueChange={handleModelValueChange}
          disabled={disabled || recoveryPending || modelSelectionState.status !== "ready"}
          tooltipTitle={modelTriggerDisplay.fullLabel}
          shortcutLabel={modelShortcutLabel}
          triggerRef={modelTriggerRef}
          open={activeConfigPicker === "model"}
          onOpenChange={handleModelPickerOpenChange}
          openRequestKey={modelMenuOpenRequestKey}
          labelVisibilityClassName={
            forceCompactModelTrigger ? "hidden" : "hidden @sm/composer:inline-flex"
          }
          indicatorClassName={
            forceCompactModelTrigger
              ? "hidden"
              : "hidden @sm/composer:block group-data-[composer-model-icon=true]/toolbar:hidden"
          }
          triggerLabelClassName={
            forceCompactModelTrigger
              ? "hidden"
              : "hidden min-w-0 text-left @sm/composer:block group-data-[composer-model-icon=true]/toolbar:hidden [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
          }
          triggerClassName={
            forceCompactModelTrigger
              ? "composer-model-trigger size-7 justify-center gap-0 p-0"
              : "composer-model-trigger max-w-[var(--composer-model-max-width,16rem)] group-data-[composer-model-icon=true]/toolbar:size-7 group-data-[composer-model-icon=true]/toolbar:p-0 group-data-[composer-model-icon=true]/toolbar:gap-0 group-data-[composer-model-icon=true]/toolbar:justify-center @max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0"
          }
          triggerIconClassName={
            forceCompactModelTrigger
              ? "inline-flex"
              : "inline-flex @sm/composer:hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
          }
          focusSelectorOnClose={V4_COMPOSER_INPUT_SELECTOR}
          providerSubmenuClassName={providerSubmenuClassName}
        />
      ) : null}
      {thoughtOption ? (
        <ThoughtLevelCycleControl
          variant={thoughtVariant}
          indicatorClassName={
            thoughtVariant === "levelBar" ? undefined : "hidden @xl/composer:block"
          }
          triggerClassName={
            // levelBar 里灯塔+竖条需要自然宽度，不能套窄宽压缩类压成 28px 方块。
            thoughtVariant === "levelBar"
              ? undefined
              : "@max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:p-0"
          }
          option={thoughtOption}
          onValueChange={handleThoughtValueChange}
          disabled={disabled || recoveryPending}
          intl={intl}
          provider={displayProvider}
          shortcutLabel={thoughtShortcutLabel}
          triggerRef={thoughtTriggerRef}
          open={activeConfigPicker === "thought"}
          onOpenChange={handleThoughtPickerOpenChange}
          restoreFocusSelector={V4_COMPOSER_INPUT_SELECTOR}
        />
      ) : null}
    </>
  );
}

export const V4ComposerModelControls = memo(V4ComposerModelControlsImpl);
import { isApiKeyAccess } from "@zcode/provider";
