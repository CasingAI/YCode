/* eslint-disable max-lines -- 网络搜索设置页集中编排候选识别、激活序与排序写回（docs/specs/web-search-provider-capability.md）。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  GripVertical,
  KeyRound,
  PackageSearch,
  Plus,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import {
  resolveWebSearchProviderOrder,
  resolveWebSearchTemplateId,
  WEB_SEARCH_PROVIDER_ENDPOINTS,
  type WebSearchCapableProviderTemplateId,
} from "@zcode/shared";
import { isApiKeyAccess, resolveProviderTemplateName } from "@zcode/provider";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { logger } from "@/logger.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  getProviderFormApiKey,
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import { projectProviderSettingsViewToFormProviders } from "@/lib/providerSettingsFormProjection.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useOptimisticReorder } from "@/settings/useOptimisticReorder.js";
import { projectCandidatesToOrder } from "@/settings/webSearchCandidateOrder.js";
import {
  buildWebSearchSourceCreateInput,
  resolveManuallyAddableSourceTemplates,
} from "@/settings/webSearchSourceCatalog.js";
import {
  WebSearchSourceDialog,
  type WebSearchProxyMode,
  type WebSearchSourceCreateInput,
  type WebSearchSourcePatch,
} from "@/settings/WebSearchSourceDialog.js";

interface WebSearchCandidate {
  providerId: string;
  label: string;
  templateId: WebSearchCapableProviderTemplateId;
  /** 模板名称，来自内置模板元数据；与实例名相同时行内不重复展示。 */
  templateLabel: string;
  hasApiKey: boolean;
  /** 是否允许在此页配置（当前只有受允许的独立搜索源）。 */
  canConfigure: boolean;
}

function candidateIds(candidates: readonly WebSearchCandidate[]): string[] {
  return candidates.map((candidate) => candidate.providerId);
}

// 与模型组成员排序同一约束：列表只做纵向排序，拖动时锁定 x=0 防横向漂移。
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function WebSearchCandidateRow({
  candidate,
  index,
  total,
  sortDisabled,
  onMove,
  onOpenSettings,
}: {
  candidate: WebSearchCandidate;
  index: number;
  total: number;
  /** 总开关关闭时只禁用排序；实例的 Key/代理配置不受影响。 */
  sortDisabled: boolean;
  onMove: (fromIndex: number, toIndex: number) => void;
  /** 仅受允许的独立搜索源提供；缺省不渲染设置按钮。 */
  onOpenSettings?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: candidate.providerId, disabled: sortDisabled });
  const isActive = index === 0;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`settings.webSearch.candidate.${candidate.providerId}`}
      className={`flex items-center gap-2 border-t border-border px-4 py-3 first:border-t-0 ${
        isDragging ? "relative z-20 bg-card shadow-md" : ""
      } ${sortDisabled ? "opacity-60" : ""}`}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        disabled={sortDisabled}
        aria-label={intl.formatMessage({ id: "settings.webSearch.dragHandle" })}
        title={intl.formatMessage({ id: "settings.webSearch.dragHandle" })}
        data-web-search-drag-handle={candidate.providerId}
        className="flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-foreground-subtlest outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-60"
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" className="size-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {candidate.label}
          </span>
          {isActive ? (
            <Badge
              variant="secondary"
              data-testid="settings.webSearch.activeBadge"
              className="gap-1"
            >
              <BadgeCheck aria-hidden="true" className="size-3" />
              {intl.formatMessage({ id: "settings.webSearch.activeBadge" })}
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ui-sm text-foreground-subtle">
          {candidate.templateLabel === candidate.label ? null : (
            <span>{candidate.templateLabel}</span>
          )}
          {candidate.hasApiKey ? null : (
            <span className="flex items-center gap-1 text-warning">
              <TriangleAlert aria-hidden="true" className="size-3" />
              {intl.formatMessage({ id: "settings.webSearch.noKey" })}
            </span>
          )}
          {WEB_SEARCH_PROVIDER_ENDPOINTS[candidate.templateId].billing === "per-call" ? (
            <span className="flex items-center gap-1">
              <KeyRound aria-hidden="true" className="size-3" />
              {intl.formatMessage({ id: "settings.webSearch.billingPerCall" })}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <KeyRound aria-hidden="true" className="size-3" />
              {intl.formatMessage({ id: "settings.webSearch.billingPlan" })}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onOpenSettings ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "settings.webSearch.sourceSettingsOpen" })}
            title={intl.formatMessage({ id: "settings.webSearch.sourceSettingsOpen" })}
            data-testid={`settings.webSearch.openSettings.${candidate.providerId}`}
            onClick={onOpenSettings}
          >
            <Settings2 aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={sortDisabled || index === 0}
          aria-label={intl.formatMessage({ id: "settings.webSearch.moveUp" })}
          data-testid={`settings.webSearch.moveUp.${candidate.providerId}`}
          onClick={() => onMove(index, index - 1)}
        >
          <ArrowUp aria-hidden="true" className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={sortDisabled || index === total - 1}
          aria-label={intl.formatMessage({ id: "settings.webSearch.moveDown" })}
          data-testid={`settings.webSearch.moveDown.${candidate.providerId}`}
          onClick={() => onMove(index, index + 1)}
        >
          <ArrowDown aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </li>
  );
}

export function WebSearchSettingsSection({
  webSearchEnabled,
  onWebSearchEnabledChange,
  workspacePath,
  workspaceIdentity,
  onOpenModelProviderSettings,
}: {
  webSearchEnabled: boolean;
  onWebSearchEnabledChange: (enabled: boolean) => Promise<void>;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenModelProviderSettings: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const { settings, update } = useSettings();
  const {
    modelProviders,
    providerTemplates,
    loading,
    reload,
    createPersonalProvider,
    saveProvider,
    deleteProvider,
  } = useModelProviders({
    workspacePath,
    workspaceIdentity,
  });

  // 添加目录 = 独立模板 × Key 型 access 的模板元数据；行设置入口复用同一目录判据。
  const sourceTemplates = useMemo(
    () => resolveManuallyAddableSourceTemplates({ templates: providerTemplates, locale }),
    [locale, providerTemplates],
  );

  // 候选识别只读本机全局事实（个人 provider_config.json），与 CLI 执行期共用同一
  // shared 判定，保证「设置页看到的」与「运行时解析的」是同一份识别结果。
  const candidates = useMemo<WebSearchCandidate[]>(
    () =>
      modelProviders.flatMap((provider) => {
        const templateId = resolveWebSearchTemplateId({
          templateId: provider.templateId ?? undefined,
          apiBaseUrl: provider.config.api?.baseUrl ?? undefined,
        });
        if (!templateId) return [];
        const template = providerTemplates.find((entry) => entry.templateId === templateId);
        return [
          {
            providerId: provider.providerId,
            label: getProviderFormLabel(provider),
            templateId,
            templateLabel: template
              ? resolveProviderTemplateName(templateId, template, locale)
              : templateId,
            hasApiKey: getProviderFormApiKey(provider).trim().length > 0,
            // 与添加目录同一判据：只有目录里的模板才允许在本页配置。
            canConfigure: sourceTemplates.some((entry) => entry.templateId === templateId),
          },
        ];
      }),
    [locale, modelProviders, providerTemplates, sourceTemplates],
  );

  const orderedCandidates = useMemo(() => {
    const orderedIds = resolveWebSearchProviderOrder({
      order: settings?.webSearchProviderOrder,
      candidates: candidates.map((candidate) => ({
        providerId: candidate.providerId,
        templateId: candidate.templateId,
      })),
    });
    return projectCandidatesToOrder(candidates, orderedIds);
  }, [candidates, settings?.webSearchProviderOrder]);

  const authoritativeIds = useMemo(() => candidateIds(orderedCandidates), [orderedCandidates]);

  const persistOrder = useCallback(
    async (ids: readonly string[]) => {
      await update({ webSearchProviderOrder: [...ids] });
    },
    [update],
  );

  // 松手后 dnd-kit 会立即清 transform，而权威顺序要等写入回读；用唯一 UI pending
  // 让拖拽和箭头都立即按新顺序渲染，避免旧 DOM 先回弹再跳位。
  const optimisticOrder = useOptimisticReorder({
    authoritativeIds,
    persist: persistOrder,
  });

  const renderedCandidates = useMemo(
    () => projectCandidatesToOrder(orderedCandidates, optimisticOrder.renderedIds),
    [orderedCandidates, optimisticOrder.renderedIds],
  );

  const commitRenderedOrder = useCallback(
    (ids: readonly string[]) => {
      void optimisticOrder.commit(ids).catch((error: unknown) => {
        // 失败由 hook 按 operationId 决定回退或保留更新的 pending，这里只记录日志。
        logger.warn("[WebSearchSettingsSection] 保存搜索源顺序失败", { error });
      });
    },
    [optimisticOrder],
  );

  const handleMove = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
      commitRenderedOrder(arrayMove(candidateIds(renderedCandidates), fromIndex, toIndex));
    },
    [commitRenderedOrder, renderedCandidates],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : "";
      if (!overId || activeId === overId) return;
      // 落点索引基于当前渲染顺序，连续拖拽才能累积在未回读的 pending 上。
      const ids = candidateIds(renderedCandidates);
      const activeIndex = ids.indexOf(activeId);
      const overIndex = ids.indexOf(overId);
      if (activeIndex < 0 || overIndex < 0) return;
      commitRenderedOrder(arrayMove(ids, activeIndex, overIndex));
    },
    [commitRenderedOrder, renderedCandidates],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ── 独立搜索源实例管理（docs/specs/web-search-provider-capability.md）──
  // 实例即 personal provider 记录：添加 = createPersonalProvider（携带模板与 Key，
  // 可重复，实例名按模板名自动去重）；Key 走 saveProvider 稀疏 overlay，代理走
  // proxyModeUpdate 元数据，删除走 deleteProvider。本页只编排现有写入路径，
  // 不新增持久化或第二份搜索源配置存储。
  const [sourceDialog, setSourceDialog] = useState<
    | { mode: "create" }
    | { mode: "edit"; providerId: string; retryProxyMode?: WebSearchProxyMode }
    | null
  >(null);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const editProvider = useMemo<ProviderSettingsFormProvider | null>(
    () =>
      sourceDialog?.mode === "edit"
        ? (modelProviders.find((provider) => provider.providerId === sourceDialog.providerId) ??
          null)
        : null,
    [modelProviders, sourceDialog],
  );

  const editTemplate = useMemo(
    () => sourceTemplates.find((template) => template.templateId === editProvider?.templateId),
    [editProvider?.templateId, sourceTemplates],
  );

  const closeSourceDialog = useCallback(() => {
    setSourceDialog(null);
    setSourceError(null);
  }, []);

  // 编辑中的实例被其它窗口删除后，provider 变为 null；自动关闭弹窗，
  // 避免对失效实例保留可点击但静默 return 的保存/删除（保存中不打断写入）。
  useEffect(() => {
    if (sourceDialog?.mode !== "edit" || sourceSaving || loading) return;
    if (modelProviders.some((provider) => provider.providerId === sourceDialog.providerId)) return;
    closeSourceDialog();
  }, [closeSourceDialog, loading, modelProviders, sourceDialog, sourceSaving]);

  const handleCreateSource = useCallback(
    async (input: WebSearchSourceCreateInput) => {
      setSourceSaving(true);
      setSourceError(null);
      let createdProviderId: string | undefined;
      try {
        const created = await createPersonalProvider(
          buildWebSearchSourceCreateInput({
            templateId: input.templateId,
            accessType: input.accessType,
            apiKey: input.apiKey,
          }),
        );
        createdProviderId = created.providerId;
        if (input.proxyMode !== "default") {
          const createdProvider = projectProviderSettingsViewToFormProviders(created.view).find(
            (provider) => provider.providerId === created.providerId,
          );
          if (!createdProvider) throw new Error("创建后的搜索源实例不在 Settings View 中");
          await saveProvider({ ...createdProvider, proxyModeUpdate: input.proxyMode });
        }
        closeSourceDialog();
      } catch (error) {
        logger.error("[WebSearchSettingsSection] 添加搜索源失败", error);
        // 实例已创建但代理写入失败时切到编辑态，重试只补代理，不会重复创建。
        if (createdProviderId) {
          setSourceDialog({
            mode: "edit",
            providerId: createdProviderId,
            retryProxyMode: input.proxyMode,
          });
        }
        setSourceError(intl.formatMessage({ id: "settings.webSearch.saveFailed" }));
      } finally {
        setSourceSaving(false);
      }
    },
    [closeSourceDialog, createPersonalProvider, intl, saveProvider],
  );

  const handleSaveSource = useCallback(
    async (provider: ProviderSettingsFormProvider, patch: WebSearchSourcePatch) => {
      setSourceSaving(true);
      setSourceError(null);
      try {
        const apiKey = patch.apiKey.trim();
        const access = provider.config.access;
        const accessType = isApiKeyAccess(access) ? access.type : "api-key";
        await saveProvider({
          ...provider,
          personalConfig: {
            ...provider.personalConfig,
            // 清空保存 = 显式清除 Key（该实例回到「未配置 Key」警示态，激活时被跳过）。
            access: { type: accessType, ...(apiKey ? { apiKey } : {}) },
          },
          proxyModeUpdate: patch.proxyMode,
        });
        closeSourceDialog();
      } catch (error) {
        logger.error("[WebSearchSettingsSection] 保存搜索源失败", error);
        setSourceError(intl.formatMessage({ id: "settings.webSearch.saveFailed" }));
      } finally {
        setSourceSaving(false);
      }
    },
    [closeSourceDialog, intl, saveProvider],
  );

  const handleDeleteSource = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      setSourceSaving(true);
      setSourceError(null);
      try {
        await deleteProvider(provider.providerId);
        closeSourceDialog();
      } catch (error) {
        logger.error("[WebSearchSettingsSection] 删除搜索源失败", error);
        setSourceError(intl.formatMessage({ id: "settings.webSearch.deleteFailed" }));
      } finally {
        setSourceSaving(false);
      }
    },
    [closeSourceDialog, deleteProvider, intl],
  );

  const addSourceButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      // 目录为空或模板仍在加载时，打开表单没有可提交的模板，直接禁用入口。
      disabled={loading || sourceTemplates.length === 0}
      data-testid="settings.webSearch.addSource"
      onClick={() => setSourceDialog({ mode: "create" })}
    >
      <Plus aria-hidden="true" className="size-4" />
      {intl.formatMessage({ id: "settings.webSearch.addSource" })}
    </Button>
  );

  const sourceDialogElement = (
    <WebSearchSourceDialog
      open={sourceDialog !== null}
      mode={sourceDialog?.mode ?? "create"}
      templates={sourceTemplates}
      provider={editProvider}
      template={editTemplate}
      saving={sourceSaving}
      errorMessage={sourceError ?? undefined}
      retryProxyMode={sourceDialog?.mode === "edit" ? sourceDialog.retryProxyMode : undefined}
      onOpenChange={(open) => {
        // 提交期间不可关闭：否则创建请求会在弹窗消失后落盘，用户看不到结果，
        // 再点添加会创建第二个实例。
        if (!open && !sourceSaving) closeSourceDialog();
      }}
      onCreate={handleCreateSource}
      onSave={handleSaveSource}
      onDelete={handleDeleteSource}
    />
  );

  const enabledSwitch = (
    <Switch
      checked={webSearchEnabled}
      data-testid="settings.webSearch.enabledSwitch"
      onCheckedChange={(checked) => {
        void onWebSearchEnabledChange(checked);
      }}
    />
  );

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.webSearch.enabled" })}
            description={intl.formatMessage({ id: "settings.webSearch.enabledDescription" })}
            control={enabledSwitch}
          />
        </SettingsGroupCard>
        <div
          data-testid="settings.webSearch.empty"
          className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center"
        >
          <PackageSearch aria-hidden="true" className="size-8 text-foreground-subtlest" />
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.webSearch.emptyTitle" })}
          </div>
          <div className="max-w-md text-ui-sm leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.webSearch.emptyHint" })}
          </div>
          <div className="flex items-center gap-2">
            {addSourceButton}
            <Button type="button" variant="ghost" onClick={onOpenModelProviderSettings}>
              {intl.formatMessage({ id: "settings.webSearch.openProviders" })}
            </Button>
          </div>
        </div>
        {sourceDialogElement}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.webSearch.enabled" })}
          description={intl.formatMessage({ id: "settings.webSearch.enabledDescription" })}
          control={enabledSwitch}
        />
      </SettingsGroupCard>
      <div className="flex items-center justify-between px-1">
        <div className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.webSearch.orderHint" })}
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void reload()}>
              {intl.formatMessage({ id: "settings.webSearch.refreshing" })}
            </Button>
          ) : null}
          {addSourceButton}
        </div>
      </div>
      {/* 拖动行会越过卡片顶部；只让这张排序卡片不裁切，其它设置卡片保持圆角裁切。 */}
      <SettingsGroupCard className="overflow-visible">
        <DndContext
          sensors={sensors}
          modifiers={[restrictToVerticalAxis]}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={[...optimisticOrder.renderedIds]}
            strategy={verticalListSortingStrategy}
            disabled={!webSearchEnabled}
          >
            <ul>
              {renderedCandidates.map((candidate, index) => (
                <WebSearchCandidateRow
                  key={candidate.providerId}
                  candidate={candidate}
                  index={index}
                  total={renderedCandidates.length}
                  sortDisabled={!webSearchEnabled}
                  onMove={handleMove}
                  onOpenSettings={
                    candidate.canConfigure
                      ? () => setSourceDialog({ mode: "edit", providerId: candidate.providerId })
                      : undefined
                  }
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </SettingsGroupCard>
      {sourceDialogElement}
    </div>
  );
}
