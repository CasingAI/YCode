/* eslint-disable max-lines -- 网络搜索设置页集中编排候选识别、激活序与排序写回（docs/specs/web-search-provider-capability.md）。 */
import { useCallback, useMemo } from "react";
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
  TriangleAlert,
} from "lucide-react";
import {
  resolveWebSearchProviderOrder,
  resolveWebSearchTemplateId,
  type WebSearchCapableProviderTemplateId,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { getProviderFormApiKey, getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

interface WebSearchCandidate {
  providerId: string;
  label: string;
  templateId: WebSearchCapableProviderTemplateId;
  hasApiKey: boolean;
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
  disabled,
  onMove,
}: {
  candidate: WebSearchCandidate;
  index: number;
  total: number;
  disabled: boolean;
  onMove: (fromIndex: number, toIndex: number) => void;
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
  } = useSortable({ id: candidate.providerId, disabled });
  const isActive = index === 0;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`settings.webSearch.candidate.${candidate.providerId}`}
      className={`flex items-center gap-2 border-t border-border px-4 py-3 first:border-t-0 ${
        isDragging ? "relative z-20 opacity-70" : ""
      } ${disabled ? "opacity-60" : ""}`}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        disabled={disabled}
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
          <span>
            {intl.formatMessage({ id: `settings.webSearch.template.${candidate.templateId}` })}
          </span>
          {candidate.hasApiKey ? null : (
            <span className="flex items-center gap-1 text-warning">
              <TriangleAlert aria-hidden="true" className="size-3" />
              {intl.formatMessage({ id: "settings.webSearch.noKey" })}
            </span>
          )}
          {candidate.templateId === "deepseek" ? (
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
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || index === 0}
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
          disabled={disabled || index === total - 1}
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
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const { modelProviders, loading, reload } = useModelProviders({
    workspacePath,
    workspaceIdentity,
  });

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
        return [
          {
            providerId: provider.providerId,
            label: getProviderFormLabel(provider),
            templateId,
            hasApiKey: getProviderFormApiKey(provider).trim().length > 0,
          },
        ];
      }),
    [modelProviders],
  );

  const orderedCandidates = useMemo(() => {
    const orderedIds = resolveWebSearchProviderOrder({
      order: settings?.webSearchProviderOrder,
      candidates: candidates.map((candidate) => ({
        providerId: candidate.providerId,
        templateId: candidate.templateId,
      })),
    });
    const candidateById = new Map(candidates.map((candidate) => [candidate.providerId, candidate]));
    return orderedIds.flatMap((providerId) => {
      const candidate = candidateById.get(providerId);
      return candidate ? [candidate] : [];
    });
  }, [candidates, settings?.webSearchProviderOrder]);

  const commitOrder = useCallback(
    async (ids: readonly string[]) => {
      await update({ webSearchProviderOrder: [...ids] });
    },
    [update],
  );

  const handleMove = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
      void commitOrder(arrayMove(candidateIds(orderedCandidates), fromIndex, toIndex));
    },
    [commitOrder, orderedCandidates],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : "";
      if (!overId || activeId === overId) return;
      const ids = candidateIds(orderedCandidates);
      const activeIndex = ids.indexOf(activeId);
      const overIndex = ids.indexOf(overId);
      if (activeIndex < 0 || overIndex < 0) return;
      void commitOrder(arrayMove(ids, activeIndex, overIndex));
    },
    [commitOrder, orderedCandidates],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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
          <Button type="button" variant="outline" onClick={onOpenModelProviderSettings}>
            {intl.formatMessage({ id: "settings.webSearch.openProviders" })}
          </Button>
        </div>
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
        {loading ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void reload()}>
            {intl.formatMessage({ id: "settings.webSearch.refreshing" })}
          </Button>
        ) : null}
      </div>
      <SettingsGroupCard>
        <DndContext
          sensors={sensors}
          modifiers={[restrictToVerticalAxis]}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={candidateIds(orderedCandidates)}
            strategy={verticalListSortingStrategy}
            disabled={!webSearchEnabled}
          >
            <ul>
              {orderedCandidates.map((candidate, index) => (
                <WebSearchCandidateRow
                  key={candidate.providerId}
                  candidate={candidate}
                  index={index}
                  total={orderedCandidates.length}
                  disabled={!webSearchEnabled}
                  onMove={handleMove}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </SettingsGroupCard>
    </div>
  );
}
