/* eslint-disable max-lines -- 设置页 provider 导航同时承载分组与拖拽排序，当前先集中维护交互边界。 */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Loader2Icon } from "lucide-react";
import { ProviderStatusIndicator } from "./ProviderStatusIndicator.js";

import {
  TID_MODEL_PROVIDER_NAV_GROUP_HANDLE,
  TID_MODEL_PROVIDER_NAV_ITEM,
  testId,
} from "@zcode/shared";
import { useCallback, useMemo, type KeyboardEvent } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ModelProviderNavGroup,
  ModelProviderNavGroupId,
  ModelProviderNavItem,
} from "./constants.js";
import { useOptimisticReorder } from "./useOptimisticReorder.js";
import { renderModelProviderNavIcon } from "./utils.js";

// 侧栏会裁切水平溢出；排序只改变纵向位置，拖动时也必须保持 x=0。
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function getSortableProviderId(
  item: ModelProviderNavItem,
  reorderableProviderIds?: ReadonlySet<string>,
): string | null {
  if (item.type === "custom" && item.provider) {
    return !reorderableProviderIds || reorderableProviderIds.has(item.provider.providerId)
      ? item.provider.providerId
      : null;
  }
  return null;
}

function resolveReorderedProviderIdsForGroup(params: {
  activeProviderId: string;
  overProviderId: string;
  providerIds: readonly string[];
}): string[] {
  const activeIndex = params.providerIds.indexOf(params.activeProviderId);
  const overIndex = params.providerIds.indexOf(params.overProviderId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return [...params.providerIds];
  }
  return arrayMove([...params.providerIds], activeIndex, overIndex);
}

function resolveReorderedGroupIds(params: {
  activeGroupId: string;
  overGroupId: string;
  groupIds: readonly string[];
}): string[] {
  const activeIndex = params.groupIds.indexOf(params.activeGroupId);
  const overIndex = params.groupIds.indexOf(params.overGroupId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return [...params.groupIds];
  }
  return arrayMove([...params.groupIds], activeIndex, overIndex);
}

function shouldShowModelProviderGroupLoadingIndicator(params: {
  groupId: ModelProviderNavGroup["id"];
  presetLoading: boolean;
  customLoading: boolean;
}): boolean {
  if (params.groupId === "opencode") {
    return params.presetLoading;
  }
  return params.customLoading;
}

/**
 * 左栏分组空态规则：所有分组一律按"有条目才显示"，没有特殊分组。
 * 注意是"有条目"不是"有启用条目"：禁用 provider 仍占条目，不能误判成空。
 */
export function isModelProviderNavGroupVisible(
  group: Pick<ModelProviderNavGroup, "id" | "items">,
): boolean {
  return group.items.length > 0;
}

function ModelProviderNavigationButton({
  item,
  label,
  selectedNodeKey,
  onSelectNavItem,
  showIcon = true,
}: {
  item: ModelProviderNavItem;
  label: string;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  showIcon?: boolean;
}) {
  const isSelected = item.key === selectedNodeKey;
  const inactiveItemClassName = "border-transparent text-foreground hover:border-border-hover/60";

  return (
    <ControlHintTooltip title={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-selected={isSelected}
        data-state={isSelected ? "selected" : "idle"}
        data-testid={testId(TID_MODEL_PROVIDER_NAV_ITEM, item.key)}
        onClick={() => {
          onSelectNavItem(item);
        }}
        className={`relative box-border flex h-8 w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors max-md:size-8 max-md:justify-center max-md:gap-0 max-md:px-0 ${
          isSelected
            ? "border-border-hover bg-card-selected text-foreground"
            : inactiveItemClassName
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {showIcon ? (
          <span className="shrink-0 text-current">{renderModelProviderNavIcon(item)}</span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 max-md:sr-only">
          <span className="min-w-0 truncate">{label}</span>
        </span>
        {"provider" in item ? <ProviderStatusIndicator provider={item.provider} /> : null}
      </button>
    </ControlHintTooltip>
  );
}

function handleModelProviderNavigationRowKeyDown({
  event,
  item,
  onSelectNavItem,
}: {
  event: KeyboardEvent<HTMLDivElement>;
  item: ModelProviderNavItem;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  onSelectNavItem(item);
}

function SortableModelProviderNavigationButton({
  providerId,
  item,
  label,
  selectedNodeKey,
  onSelectNavItem,
}: {
  providerId: string;
  item: ModelProviderNavItem;
  label: string;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: providerId,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const isSelected = item.key === selectedNodeKey;
  const inactiveItemClassName = "border-transparent text-foreground hover:border-border-hover/60";
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    listeners?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    handleModelProviderNavigationRowKeyDown({ event, item, onSelectNavItem });
  };

  return (
    <ControlHintTooltip title={label} side="right">
      <div
        ref={setNodeRef}
        style={style}
        aria-label={label}
        aria-selected={isSelected}
        data-state={isSelected ? "selected" : "idle"}
        data-testid={testId(TID_MODEL_PROVIDER_NAV_ITEM, item.key)}
        onClick={() => onSelectNavItem(item)}
        {...attributes}
        {...listeners}
        onKeyDown={handleKeyDown}
        className={`relative box-border flex h-8 w-full cursor-grab touch-pan-y select-none items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 max-md:size-8 max-md:justify-center max-md:gap-0 max-md:px-0 ${
          isSelected
            ? "border-border-hover bg-card-selected text-foreground"
            : inactiveItemClassName
        } ${isDragging ? "z-20 opacity-70" : ""}`}
      >
        <span className="shrink-0 text-current" aria-hidden="true">
          {renderModelProviderNavIcon(item)}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 max-md:sr-only">
          <span className="min-w-0 truncate">{label}</span>
        </span>
        {"provider" in item ? <ProviderStatusIndicator provider={item.provider} /> : null}
      </div>
    </ControlHintTooltip>
  );
}

function SortableProviderNavigationGroup({
  group,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  sensors,
}: {
  group: ModelProviderNavGroup;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  sensors: ReturnType<typeof useSensors>;
}) {
  const authoritativeProviderIds = useMemo(
    () =>
      group.items.flatMap((item) => {
        const providerId = getSortableProviderId(item, reorderableProviderIds);
        return providerId ? [providerId] : [];
      }),
    [group.items, reorderableProviderIds],
  );
  const persist = useCallback(
    async (providerIds: readonly string[]) => {
      await onReorderProviderIds?.([...providerIds]);
    },
    [onReorderProviderIds],
  );
  const optimisticOrder = useOptimisticReorder({
    authoritativeIds: authoritativeProviderIds,
    persist,
  });
  const renderedItems = useMemo(
    () =>
      projectItemsToOptimisticProviderOrder({
        items: group.items,
        providerIds: optimisticOrder.renderedIds,
        reorderableProviderIds,
      }),
    [group.items, optimisticOrder.renderedIds, reorderableProviderIds],
  );

  return (
    <DndContext
      sensors={sensors}
      modifiers={[restrictToVerticalAxis]}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        const activeProviderId = String(event.active.id);
        const overProviderId = event.over ? String(event.over.id) : "";
        if (!overProviderId || activeProviderId === overProviderId) return;
        const nextProviderIds = resolveReorderedProviderIdsForGroup({
          activeProviderId,
          overProviderId,
          providerIds: optimisticOrder.renderedIds,
        });
        void optimisticOrder.commit(nextProviderIds).catch(() => undefined);
      }}
    >
      <SortableContext
        items={[...optimisticOrder.renderedIds]}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col gap-1 max-md:items-center">
          {renderedItems.map((item) => {
            const providerId = getSortableProviderId(item, reorderableProviderIds);
            if (!providerId) {
              return (
                <ModelProviderNavigationButton
                  key={item.key}
                  item={item}
                  label={item.label}
                  selectedNodeKey={selectedNodeKey}
                  onSelectNavItem={onSelectNavItem}
                />
              );
            }
            return (
              <SortableModelProviderNavigationButton
                key={item.key}
                providerId={providerId}
                item={item}
                label={item.label}
                selectedNodeKey={selectedNodeKey}
                onSelectNavItem={onSelectNavItem}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function projectItemsToOptimisticProviderOrder({
  items,
  providerIds,
  reorderableProviderIds,
}: {
  items: readonly ModelProviderNavItem[];
  providerIds: readonly string[];
  reorderableProviderIds?: ReadonlySet<string>;
}): ModelProviderNavItem[] {
  const itemByProviderId = new Map(
    items.flatMap((item) => {
      const providerId = getSortableProviderId(item, reorderableProviderIds);
      return providerId ? ([[providerId, item]] as const) : [];
    }),
  );
  let providerIndex = 0;
  return items.map((item) => {
    if (!getSortableProviderId(item, reorderableProviderIds)) return item;
    const providerId = providerIds[providerIndex++];
    return (providerId && itemByProviderId.get(providerId)) || item;
  });
}

interface ModelProviderNavGroupDragActivator {
  setActivatorNodeRef: (node: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  dragLabel: string;
}

/**
 * 分组标题行。传入 activator 时右侧出现整组拖拽把手（GripVertical，悬停显隐），
 * 与 WorkspaceSidebar 的 purpose section 拖拽把手同一套视觉与可访问性约定。
 */
function ModelProviderNavGroupHeader({
  group,
  presetLoading,
  customLoading,
  activator,
}: {
  group: ModelProviderNavGroup;
  presetLoading: boolean;
  customLoading: boolean;
  activator?: ModelProviderNavGroupDragActivator;
}) {
  return (
    <div className="flex h-7 items-center justify-between px-2 py-1 max-md:hidden">
      <h3 className="text-ui-sm font-semibold text-foreground-subtlest">{group.title}</h3>
      <span className="flex shrink-0 items-center gap-0.5">
        {shouldShowModelProviderGroupLoadingIndicator({
          groupId: group.id,
          presetLoading,
          customLoading,
        }) ? (
          <Loader2Icon className="size-3 animate-spin text-foreground-subtlest" />
        ) : null}
        {activator ? (
          <button
            ref={activator.setActivatorNodeRef}
            type="button"
            aria-label={activator.dragLabel}
            data-testid={testId(TID_MODEL_PROVIDER_NAV_GROUP_HANDLE, group.id)}
            className="flex size-5 touch-none cursor-grab items-center justify-center rounded-md text-foreground-subtlest outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 active:cursor-grabbing"
            {...activator.attributes}
            {...activator.listeners}
          >
            <GripVertical aria-hidden="true" className="size-3" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

function PlainModelProviderNavGroupSection({
  group,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  sensors,
  presetLoading,
  customLoading,
}: {
  group: ModelProviderNavGroup;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  sensors: ReturnType<typeof useSensors>;
  presetLoading: boolean;
  customLoading: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 max-md:gap-1">
      <ModelProviderNavGroupHeader
        group={group}
        presetLoading={presetLoading}
        customLoading={customLoading}
      />
      <SortableProviderNavigationGroup
        group={group}
        selectedNodeKey={selectedNodeKey}
        onSelectNavItem={onSelectNavItem}
        onReorderProviderIds={onReorderProviderIds}
        reorderableProviderIds={reorderableProviderIds}
        sensors={sensors}
      />
    </div>
  );
}

function SortableModelProviderNavGroupSection({
  group,
  dragLabel,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  sensors,
  presetLoading,
  customLoading,
}: {
  group: ModelProviderNavGroup;
  dragLabel: string;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  sensors: ReturnType<typeof useSensors>;
  presetLoading: boolean;
  customLoading: boolean;
}) {
  // useSortable 必须只对同一个分组 id 调用一次：setNodeRef 挂分组容器、
  // setActivatorNodeRef 挂标题行把手。拆成两个 hook 实例会在 dnd-kit 注册表里
  // 互相覆盖，拖动激活时拿不到 DOM 节点，表现为"完全拖不动"。
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={`flex flex-col gap-2 max-md:gap-1 ${isDragging ? "relative z-20 opacity-85" : ""}`}
    >
      <ModelProviderNavGroupHeader
        group={group}
        presetLoading={presetLoading}
        customLoading={customLoading}
        activator={{ setActivatorNodeRef, attributes, listeners, dragLabel }}
      />
      <SortableProviderNavigationGroup
        group={group}
        selectedNodeKey={selectedNodeKey}
        onSelectNavItem={onSelectNavItem}
        onReorderProviderIds={onReorderProviderIds}
        reorderableProviderIds={reorderableProviderIds}
        sensors={sensors}
      />
    </div>
  );
}

export function ModelProviderSectionNavigation({
  navigationGroups,
  selectedNodeKey,
  presetLoading,
  customLoading,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  onReorderNavGroups,
}: {
  navigationGroups: ModelProviderNavGroup[];
  selectedNodeKey: string | null;
  presetLoading: boolean;
  customLoading: boolean;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  onReorderNavGroups?: (groupIds: ModelProviderNavGroupId[]) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const visibleGroups = useMemo(
    () => navigationGroups.filter(isModelProviderNavGroupVisible),
    [navigationGroups],
  );
  const groupById = useMemo(
    () => new Map(visibleGroups.map((group) => [group.id, group])),
    [visibleGroups],
  );
  const authoritativeGroupIds = useMemo(
    () => visibleGroups.map((group) => group.id),
    [visibleGroups],
  );
  const persistGroupOrder = useCallback(
    async (groupIds: readonly string[]) => {
      // useOptimisticReorder 是泛型 string 管线；这里成员受 haveSameMembers
      // 守卫约束，只会是 navigationGroups 的分组 id，可以安全收窄。
      await onReorderNavGroups?.(groupIds as ModelProviderNavGroupId[]);
    },
    [onReorderNavGroups],
  );
  const groupOrdering = useOptimisticReorder({
    authoritativeIds: authoritativeGroupIds,
    persist: persistGroupOrder,
  });
  const groupDragLabel = intl.formatMessage({ id: "settings.modelProvider.reorderGroup" });
  const groupDragEnabled = Boolean(onReorderNavGroups);

  const renderGroup = (group: ModelProviderNavGroup) => {
    const sectionProps = {
      group,
      selectedNodeKey,
      onSelectNavItem,
      onReorderProviderIds,
      reorderableProviderIds,
      sensors,
      presetLoading,
      customLoading,
    };
    if (!groupDragEnabled) {
      return <PlainModelProviderNavGroupSection key={group.id} {...sectionProps} />;
    }
    return (
      <SortableModelProviderNavGroupSection
        key={group.id}
        {...sectionProps}
        dragLabel={groupDragLabel}
      />
    );
  };

  if (!groupDragEnabled) {
    return (
      <aside className="px-1.5 py-3 md:py-2 md:px-2">
        <div className="flex min-h-0 flex-col gap-3 max-md:gap-1">
          {visibleGroups.map((group) => renderGroup(group))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="px-1.5 py-3 md:py-2 md:px-2">
      <DndContext
        sensors={sensors}
        modifiers={[restrictToVerticalAxis]}
        collisionDetection={closestCenter}
        onDragEnd={(event: DragEndEvent) => {
          const activeGroupId = String(event.active.id);
          const overGroupId = event.over ? String(event.over.id) : "";
          if (!overGroupId || activeGroupId === overGroupId) return;
          const nextGroupIds = resolveReorderedGroupIds({
            activeGroupId,
            overGroupId,
            groupIds: groupOrdering.renderedIds,
          });
          void groupOrdering.commit(nextGroupIds).catch(() => undefined);
        }}
      >
        <SortableContext
          items={[...groupOrdering.renderedIds]}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex min-h-0 flex-col gap-3 max-md:gap-1">
            {groupOrdering.renderedIds.map((groupId) => {
              // renderedIds 成员受 useOptimisticReorder 的 haveSameMembers 守卫，
              // 只会是 authoritativeGroupIds（即 navigationGroups 的分组 id）。
              const group = groupById.get(groupId as ModelProviderNavGroupId);
              return group ? renderGroup(group) : null;
            })}
          </div>
        </SortableContext>
      </DndContext>
    </aside>
  );
}
