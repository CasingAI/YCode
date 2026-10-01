/* eslint-disable max-lines -- 命令管理面板集中维护列表、表单和外部导入入口，拆分会增加跨状态跳转成本 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type {
  BuiltinCommand,
  CommandConfig,
  ModelSelection,
  UserCommand,
  ZCodeCommand,
} from "@zcode/shared";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import {
  isBuiltinCommand,
  isPluginCommand,
  isUserCommand,
  sameModelSelection,
  ZCODE_AGENT_PROVIDER,
  ZCODE_COMMAND_AGENT_SOURCE,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useCommands } from "@/hooks/useCommands.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { CommandCard, isEditableUserCommand } from "@/settings/CommandCard.js";
import { BuiltinCommandDetail } from "@/settings/BuiltinCommandDetail.js";
import { toOverrideModelSelection } from "@/settings/ModelOverrideControl.js";
import { refreshWorkspaceSlashCommandsAfterBindingChange } from "@/settings/refreshWorkspaceSlashCommands.js";
import { CommandForm } from "@/settings/CommandForm.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { CommandsImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { groupCommandsByPlugin } from "@/settings/pluginManagedResourceGroups.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  selectCommandsForScope,
  selectPluginsForScope,
} from "@/settings/pluginCapabilityProjection.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  resolveCommandScopeRecovery,
  resolveCommandStorageTarget,
  shouldRefreshCurrentCommandList,
} from "@/settings/commandWorkspaceScope.js";

interface CommandsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  scopeFilter: "user" | "workspace";
  parentScopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onEditorOpenChange?: (open: boolean) => void;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
}

export function CommandsSection({
  workspacePath,
  workspaceIdentity,
  scopeFilter,
  parentScopeKey,
  workspaceTabs,
  searchQuery,
  onVisibleCountChange,
  onEditorOpenChange,
  onFormScopeKeyChange,
}: CommandsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();

  const currentWorkspaceKey = workspaceIdentity?.trim() || workspacePath || "";
  const currentWorkspaceTab = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === currentWorkspaceKey,
  );
  // 列表按 Scope target 收到 workspacePath，但命令与插件服务仍取自当前
  // ServiceProvider，会把 B 的路径发往 A 的 remote host。两者统一走 target 解析结果，
  // 并在连接就绪前暂停 RPC，不回退到当前激活 workspace 的 service。
  const listServiceResolution = useWorkspaceServicesResolution(
    currentWorkspaceTab?.workspacePath ?? workspacePath,
    currentWorkspaceTab?.remoteSessionId,
    currentWorkspaceTab?.workspaceIdentity ?? workspaceIdentity,
    currentWorkspaceTab?.remoteTarget,
  );
  const { commandsService, pluginManagementService, settingsSyncService } =
    listServiceResolution.services;

  const {
    commands,
    builtinCommands,
    capability,
    loading,
    error,
    operatingCommandId,
    projectionMatchesTarget,
    refresh,
    deleteCommand,
    toggleCommand,
    setBuiltinCommandModelOverride,
  } = useCommands({
    workspacePath: workspacePath ?? undefined,
    workspaceIdentity,
    commandsService,
    enabled: listServiceResolution.rpcReady,
  });

  // 命令绑定模型的候选目录与子智能体一致，统一来自 Local Host View；
  // 覆盖写入仍按列表 target 的 commandsService 落盘。
  const localHostServices = useBaseWorkspaceServices();
  const modelSelectionRead = useModelSelectionServiceView(localHostServices.modelSelectionService);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // 非 Ready 生命周期均保留控件当前选择；读取失败不能被误判成模型已失效。
  const modelSelectionLoading = modelSelectionRead.state.status !== "ready";
  const chatModelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView, {
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
  }, [intl, modelSelectionView]);

  const [showForm, setShowForm] = useState(false);
  const [editingCommand, setEditingCommand] = useState<UserCommand | null>(null);
  const [selectedBuiltin, setSelectedBuiltin] = useState<BuiltinCommand | null>(null);
  const [saving, setSaving] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState(parentScopeKey);
  const formTargetWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === formScopeKey,
  );
  const formServiceTarget = formTargetWorkspace ?? currentWorkspaceTab;
  const formServiceResolution = useWorkspaceServicesResolution(
    formServiceTarget?.workspacePath ?? workspacePath,
    formServiceTarget?.remoteSessionId,
    formServiceTarget?.workspaceIdentity ?? workspaceIdentity,
    formServiceTarget?.remoteTarget,
  );
  const formServices = formServiceResolution.services;

  useEffect(() => {
    const recovery = resolveCommandScopeRecovery({
      editing: Boolean(editingCommand),
      scopeKey: formScopeKey,
      workspaceTabs,
    });
    if (recovery === "keep") return;
    // 目标 Workspace 关闭后不能继续向失效路径写入；新建回退 User，编辑直接退出。
    if (recovery === "close-editor") {
      setEditingCommand(null);
      setSelectedBuiltin(null);
      setShowForm(false);
      return;
    }
    setFormScopeKey("user");
  }, [editingCommand, formScopeKey, workspaceTabs]);

  const plugins = usePluginManagementStore((state) => state.plugins);
  const pluginStoreWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginStoreWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);

  useEffect(() => {
    if (!workspacePath || !listServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      configScope: scopeFilter,
      pluginService: pluginManagementService,
    });
  }, [
    initializePlugins,
    listServiceResolution.rpcReady,
    pluginManagementService,
    scopeFilter,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleSave = useCallback(
    async (
      config: CommandConfig,
      scopeKey: string,
      modelSelection: ModelSelection | undefined,
      mode: SubmissionMode | undefined,
      modeTouched: boolean,
    ) => {
      setSaving(true);
      try {
        const { storageLevel, workspace: targetWorkspace } = resolveCommandStorageTarget(
          scopeKey,
          workspaceTabs,
        );
        const targetWorkspacePath =
          storageLevel === "project" ? targetWorkspace?.workspacePath : undefined;
        if (storageLevel === "project" && !targetWorkspacePath) {
          throw new Error("Selected Workspace is no longer available");
        }
        let savedFilePath: string | undefined;
        if (editingCommand) {
          const { command } = await formServices.commandsService.updateCommandFile({
            agentSource: editingCommand.agentSource,
            commandId: editingCommand.id,
            config,
            oldFilePath: editingCommand.filePath,
            storageLevel,
            workspacePath: targetWorkspacePath,
          });
          savedFilePath = command.filePath;
          // updateCommandFile 重写文件时保留旧文件头的 model / mode 键（generate 逻辑），
          // 这里只在表单模型/模式与落盘结果不一致时才做第二步覆盖写，避免无谓写盘。
          // mode 缺省（modeTouched 为 false）表示表单未动模式区，本次不碰 mode 键。
          const modeMismatch = modeTouched && (command.modeOverride ?? undefined) !== mode;
          if (!sameModelSelection(command.modelSelectionOverride, modelSelection) || modeMismatch) {
            await formServices.commandsService.setCommandModelOverride({
              commandId: command.id,
              filePath: command.filePath,
              ...(modelSelection ? { modelSelection } : {}),
              ...(modeTouched ? { mode } : {}),
            });
          }
        } else {
          const { command } = await formServices.commandsService.writeCommandFile({
            config,
            agentSource: ZCODE_COMMAND_AGENT_SOURCE,
            storageLevel,
            workspacePath: targetWorkspacePath,
          });
          savedFilePath = command.filePath;
          // 新建文件没有文件头绑定；表单选了模型/模式才补写，未选直接跳过。
          if (modelSelection || mode) {
            await formServices.commandsService.setCommandModelOverride({
              commandId: command.id,
              filePath: command.filePath,
              ...(modelSelection ? { modelSelection } : {}),
              ...(mode ? { mode } : {}),
            });
          }
        }
        if (shouldRefreshCurrentCommandList(scopeKey, currentWorkspaceKey)) {
          await refresh();
        }
        // 绑定变更同样要刷新输入框目录，与行内即改即存的提交点语义一致。
        if (savedFilePath && workspacePath) {
          await refreshWorkspaceSlashCommandsAfterBindingChange({
            workspacePath,
            workspaceIdentity,
            zcodeSessionService: listServiceResolution.services.zcodeSessionService,
          });
        }
        setShowForm(false);
        setEditingCommand(null);
        setFormScopeKey("user");
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : String(saveError);
        if (message.includes("exists") || message.includes("already")) {
          toast(
            intl.formatMessage(
              { id: "forms.validation.fileExists" },
              { fileName: `${config.name.replace(/^\//, "")}.md` },
            ),
          );
        } else {
          toast(message);
        }
      } finally {
        setSaving(false);
      }
    },
    [
      currentWorkspaceKey,
      editingCommand,
      formServices.commandsService,
      intl,
      listServiceResolution.services.zcodeSessionService,
      refresh,
      workspaceIdentity,
      workspacePath,
      workspaceTabs,
    ],
  );

  const handleDelete = useCallback(
    async (command: ZCodeCommand) => {
      if (!isEditableUserCommand(command)) {
        return;
      }
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.commands.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.commands.delete.description" },
          { name: command.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      try {
        await deleteCommand({
          agentSource: command.agentSource,
          commandId: command.id,
          filePath: command.filePath,
        });
        setEditingCommand(null);
        setShowForm(false);
      } catch (deleteError) {
        const message = deleteError instanceof Error ? deleteError.message : String(deleteError);
        toast(message);
      }
    },
    [confirmDialog, deleteCommand, intl],
  );

  const handleToggle = useCallback(
    async (command: ZCodeCommand, enabled: boolean) => {
      if (!isUserCommand(command)) {
        return;
      }
      try {
        await toggleCommand({
          agentSource: command.agentSource,
          commandId: command.id,
          filePath: command.filePath,
          enabled,
        });
      } catch (toggleError) {
        const message = toggleError instanceof Error ? toggleError.message : String(toggleError);
        toast(message);
      }
    },
    [toggleCommand],
  );

  const handleEdit = useCallback(
    (command: ZCodeCommand) => {
      if (!isEditableUserCommand(command)) {
        return;
      }
      setFormScopeKey(command.scope === "project" ? parentScopeKey : "user");
      setEditingCommand(command);
      setSelectedBuiltin(null);
      setShowForm(false);
    },
    [parentScopeKey],
  );

  const handleBuiltinDetailOpen = useCallback((command: ZCodeCommand) => {
    if (!isBuiltinCommand(command)) {
      return;
    }
    setSelectedBuiltin(command);
    setEditingCommand(null);
    setShowForm(false);
  }, []);

  const handleCancelBuiltinDetail = useCallback(() => {
    setSelectedBuiltin(null);
  }, []);

  // 详情页控件按命令类型分派存储：只剩内置走用户 CLI 配置段（用户命令的绑定
  // 已并入编辑表单的保存两步写）。失败时抛给 ModelOverrideControl 回滚本地选择。
  const handleModelOverridePersist = useCallback(
    async (command: BuiltinCommand, next: { model?: string; thoughtLevel?: string }) => {
      const modelSelection = toOverrideModelSelection(next.model, next.thoughtLevel);
      try {
        await setBuiltinCommandModelOverride(command.name, modelSelection);
      } catch (persistError) {
        toast(persistError instanceof Error ? persistError.message : String(persistError));
        throw persistError;
      }
      // 写盘成功即为提交点；输入框的斜杠目录不会自己更新，必须现拉一次写回，
      // 否则同一会话再插入命令仍按旧绑定着色（docs/specs/command-model-binding.md）。
      if (workspacePath) {
        await refreshWorkspaceSlashCommandsAfterBindingChange({
          workspacePath,
          workspaceIdentity,
          zcodeSessionService: listServiceResolution.services.zcodeSessionService,
        });
      }
    },
    [
      listServiceResolution.services.zcodeSessionService,
      setBuiltinCommandModelOverride,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleAddNew = useCallback(() => {
    setFormScopeKey(parentScopeKey);
    setEditingCommand(null);
    setShowForm(true);
  }, [parentScopeKey]);

  const handleCancelForm = useCallback(() => {
    setFormScopeKey("user");
    setShowForm(false);
    setEditingCommand(null);
  }, []);

  const handleFormScopeKeyChange = useCallback(
    (scopeKey: string) => {
      setFormScopeKey(scopeKey);
      onFormScopeKeyChange?.(scopeKey);
    },
    [onFormScopeKeyChange],
  );

  // pluginManagementStore 是全局单例，Plugins tab 的 PluginList 与本页在
  // effectiveCommandScopeKey ≠ selectedScopeKey 时会用不同 target 交替初始化它。
  // PluginList 已用 storeKey!==targetKey 自保护，这里复用同一模式，避免插件贡献的
  // 命令分组短暂取自别的 target 的插件投影。
  const pluginStoreMatchesTarget =
    (pluginStoreWorkspaceIdentity?.trim() || pluginStoreWorkspacePath || "") ===
      currentWorkspaceKey && pluginConfigScope === scopeFilter;
  const scopedPlugins = useMemo(
    () =>
      pluginStoreMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, scopeFilter) : [],
    [installedPlugins, plugins, pluginStoreMatchesTarget, scopeFilter],
  );
  const scopedCommands = useMemo(
    () => selectCommandsForScope(commands, scopedPlugins, scopeFilter),
    [commands, scopeFilter, scopedPlugins],
  );
  const groupedCommands = useMemo(
    () => groupCommandsByPlugin(scopedCommands, searchQuery),
    [scopedCommands, searchQuery],
  );

  // 内置命令是用户级配置，User / Workspace 两个作用域都显示同一组：
  // 只在一边显示会让切作用域的用户误以为命令消失——那正是本分组要消掉的落差。
  const visibleBuiltinCommands = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return builtinCommands;
    return builtinCommands.filter((command) =>
      [command.name, command.description, command.inputHint].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [builtinCommands, searchQuery]);

  const filteredCommandCount =
    groupedCommands.local.length + groupedCommands.plugin.length + visibleBuiltinCommands.length;
  useEffect(() => {
    onVisibleCountChange?.(filteredCommandCount);
  }, [filteredCommandCount, onVisibleCountChange]);
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const pluginCommandGroups = useMemo(() => {
    const groups = new Map<string, typeof groupedCommands.plugin>();
    for (const command of groupedCommands.plugin) {
      const key = `${command.pluginName.trim()}@${command.pluginMarketplace.trim()}`;
      groups.set(key, [...(groups.get(key) ?? []), command]);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [groupedCommands.plugin]);
  const hasEmptySearchResult = Boolean(searchQuery.trim()) && filteredCommandCount === 0;
  const directInstalledCommandCount = scopedCommands.filter(isUserCommand).length;
  const hideInstalledGroup = Boolean(searchQuery.trim()) && groupedCommands.local.length === 0;
  const hideBuiltinGroup = Boolean(searchQuery.trim()) && visibleBuiltinCommands.length === 0;

  // 详情页即改即存只剩内置命令用；用户命令的绑定已并入编辑表单保存。
  const builtinDetailOverridePropsFor = (command: BuiltinCommand) => ({
    modelGroups: chatModelSelectGroups,
    modelSelectionView,
    modelSelectionLoading,
    onPersist: (next: { model?: string; thoughtLevel?: string }) =>
      handleModelOverridePersist(command, next),
  });

  // 列表行只读展示当前绑定；用户行与系统行可点进入各自详情，插件行不可点。
  const bindingDisplayProps = {
    modelGroups: chatModelSelectGroups,
    modelSelectionLoading,
    inheritLabel: intl.formatMessage({ id: "settings.subagents.model.defaultMain" }),
  };

  const renderCommandList = (items: ZCodeCommand[]) => (
    <SettingsResourceList
      items={items}
      getKey={(command) => command.id}
      renderItem={(command) => (
        <CommandCard
          command={command}
          onEdit={isEditableUserCommand(command) ? handleEdit : undefined}
          onToggle={isUserCommand(command) ? handleToggle : undefined}
          isOperating={operatingCommandId === command.id}
          bindingDisplay={isUserCommand(command) ? bindingDisplayProps : undefined}
          binding={isUserCommand(command) ? command.modelSelectionOverride : undefined}
          // 模式绑定列表行只读展示，修改统一进编辑表单。
          modeBinding={isUserCommand(command) ? command.modeOverride : undefined}
          pluginIconItem={
            isPluginCommand(command)
              ? {
                  name: command.pluginName,
                  listing: pluginListingById.get(
                    `${command.pluginName.trim()}@${command.pluginMarketplace.trim()}`,
                  ),
                }
              : undefined
          }
        />
      )}
    />
  );

  // 系统行可点进入子集详情页；无开关。绑定只在详情页改，列表只读展示。
  const renderBuiltinCommandList = (items: readonly BuiltinCommand[]) => (
    <SettingsResourceList
      items={items}
      getKey={(command) => command.id}
      renderItem={(command) => (
        <CommandCard
          command={command}
          onEdit={handleBuiltinDetailOpen}
          bindingDisplay={bindingDisplayProps}
          binding={command.modelSelectionOverride}
        />
      )}
    />
  );

  // 系统详情与用户表单互斥：同一时刻最多一个详情视图，避免两处可改同一份绑定。
  const isFormView = showForm || editingCommand !== null;
  const isDetailView = selectedBuiltin !== null && !isFormView;
  useEffect(() => {
    onEditorOpenChange?.(isFormView || isDetailView);
    onFormScopeKeyChange?.(isFormView ? formScopeKey : null);
    return () => {
      onEditorOpenChange?.(false);
      onFormScopeKeyChange?.(null);
    };
  }, [formScopeKey, isDetailView, isFormView, onEditorOpenChange, onFormScopeKeyChange]);
  if (isDetailView) {
    // 详情页读 store 投影里的最新行：即改即存写盘后整表刷新，直接用旧快照会显示旧绑定。
    const liveBuiltin =
      builtinCommands.find((command) => command.id === selectedBuiltin.id) ?? selectedBuiltin;
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={[{ label: `/${liveBuiltin.name}` }]}
          onSectionSelect={handleCancelBuiltinDetail}
        />
        <BuiltinCommandDetail
          command={liveBuiltin}
          modelOverride={builtinDetailOverridePropsFor(liveBuiltin)}
        />
      </div>
    );
  }
  if (isFormView) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingCommand?.name ?? intl.formatMessage({ id: "settings.commands.addNew" }),
            },
          ]}
          onSectionSelect={handleCancelForm}
        />
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-ui-xl font-semibold text-foreground">
              {editingCommand
                ? intl.formatMessage({ id: "settings.commands.edit" })
                : intl.formatMessage({ id: "settings.commands.addNew" })}
            </h3>
            <p className="text-ui-base text-foreground-subtle">
              {editingCommand
                ? intl.formatMessage({
                    id: "settings.commands.editDescription",
                  })
                : intl.formatMessage({
                    id: "settings.commands.addDescription",
                  })}
            </p>
          </div>

          <CommandForm
            initial={editingCommand ?? undefined}
            agentSource={editingCommand?.agentSource ?? ZCODE_COMMAND_AGENT_SOURCE}
            scopeKey={formScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={handleFormScopeKeyChange}
            onSave={handleSave}
            onCancel={handleCancelForm}
            onDelete={editingCommand ? handleDelete : undefined}
            saving={saving}
            modelSection={{ modelSelectionView, modelSelectionLoading }}
          />
        </div>
      </div>
    );
  }

  const headerActions = (
    <SettingsResourceHeaderActions
      onRefresh={() => void refresh()}
      onImport={() => setImportDialogOpen(true)}
      onNew={handleAddNew}
      importDisabled={!capability?.userScopeAvailable}
    />
  );

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {!listServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading || !projectionMatchesTarget ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.commands.searchEmpty",
          })}
        />
      ) : (
        <div className="space-y-6">
          <section className={hideInstalledGroup ? "hidden" : "space-y-4"}>
            <SettingsResourceGroupHeader
              actions={headerActions}
              count={groupedCommands.local.length}
              title={intl.formatMessage({
                id: "settings.plugin.commands.installed",
              })}
            />
            {groupedCommands.local.length > 0 ? (
              renderCommandList(groupedCommands.local)
            ) : directInstalledCommandCount === 0 && !searchQuery.trim() ? (
              <PluginInstallEmptyState
                title={intl.formatMessage({
                  id: "settings.plugin.commands.emptyInstalledTitle",
                })}
                description={intl.formatMessage({
                  id: "settings.plugin.commands.emptyInstalledDescription",
                })}
                actions={
                  <Button type="button" variant="default" size="lg" onClick={handleAddNew}>
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.create.action" })}
                  </Button>
                }
              />
            ) : null}
          </section>
          {pluginCommandGroups.map(([pluginId, items]) => (
            <section key={pluginId} className="space-y-4">
              <SettingsResourceGroupHeader
                count={items.length}
                title={resolvePluginDisplayName(
                  {
                    name: items[0]?.pluginName ?? pluginId,
                    listing: pluginListingById.get(pluginId),
                  },
                  locale,
                )}
              />
              {renderCommandList(items)}
            </section>
          ))}
          <section className={hideBuiltinGroup ? "hidden" : "space-y-4"}>
            <SettingsResourceGroupHeader
              count={visibleBuiltinCommands.length}
              title={intl.formatMessage({
                id: "settings.plugin.commands.builtin",
              })}
            />
            {renderBuiltinCommandList(visibleBuiltinCommands)}
          </section>
        </div>
      )}
      <CommandsImportDialog
        open={importDialogOpen && listServiceResolution.rpcReady}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        settingsSyncService={settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={refresh}
      />
    </div>
  );
}
