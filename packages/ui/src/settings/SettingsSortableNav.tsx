/* eslint-disable max-lines -- 设置页共享可排序导航：行样式、拖拽与窄屏收纳集中一处，供应商与模型组共用。 */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useMemo } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptimisticReorder } from "@/settings/useOptimisticReorder.js";

/** 共享导航行：只认 key/label/icon/trailing，不带任何供应商或模型组语义。 */
export interface SettingsSortableNavItem {
  readonly key: string;
  readonly label: string;
  readonly testId: string;
  readonly icon: ReactNode;
  readonly trailing?: ReactNode;
  readonly disabled?: boolean;
}

export interface SettingsSortableNavGroup {
  readonly id: string;
  readonly title?: string;
  readonly items: readonly SettingsSortableNavItem[];
}

// 侧栏会裁切水平溢出；排序只改变纵向位置，拖动时也必须保持 x=0（与供应商原逻辑一致）。
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

const ROW_BASE_CLASS =
  "relative box-border flex h-8 w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors max-md:size-8 max-md:justify-center max-md:gap-0 max-md:px-0";
const ROW_IDLE_CLASS = "border-transparent text-foreground hover:border-border-hover/60";
const ROW_SELECTED_CLASS = "border-border-hover bg-card-selected text-foreground";

function resolveReorderedKeys(params: {
  activeKey: string;
  overKey: string;
  keys: readonly string[];
}): string[] {
  const activeIndex = params.keys.indexOf(params.activeKey);
  const overIndex = params.keys.indexOf(params.overKey);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return [...params.keys];
  }
  return arrayMove([...params.keys], activeIndex, overIndex);
}

function SettingsSortableNavButton({
  item,
  selected,
  disabled,
  onSelect,
}: {
  item: SettingsSortableNavItem;
  selected: boolean;
  disabled?: boolean;
  onSelect: (item: SettingsSortableNavItem) => void;
}) {
  return (
    <ControlHintTooltip title={item.label} side="right">
      <button
        type="button"
        disabled={disabled || item.disabled}
        aria-label={item.label}
        aria-selected={selected}
        data-state={selected ? "selected" : "idle"}
        data-testid={item.testId}
        onClick={() => onSelect(item)}
        className={`${ROW_BASE_CLASS} ${selected ? ROW_SELECTED_CLASS : ROW_IDLE_CLASS} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <span className="shrink-0 text-current" aria-hidden="true">
          {item.icon}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 max-md:sr-only">
          <span className="min-w-0 truncate">{item.label}</span>
        </span>
        {item.trailing ? (
          <span className="shrink-0 max-md:hidden" aria-hidden="true">
            {item.trailing}
          </span>
        ) : null}
      </button>
    </ControlHintTooltip>
  );
}

function handleSortableRowKeyDown({
  event,
  item,
  onSelect,
}: {
  event: KeyboardEvent<HTMLDivElement>;
  item: SettingsSortableNavItem;
  onSelect: (item: SettingsSortableNavItem) => void;
}) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  onSelect(item);
}

function SortableSettingsNavButton({
  item,
  selected,
  disabled,
  onSelect,
}: {
  item: SettingsSortableNavItem;
  selected: boolean;
  disabled?: boolean;
  onSelect: (item: SettingsSortableNavItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.key,
    disabled: disabled || item.disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const rowDisabled = disabled || item.disabled;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    listeners?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    handleSortableRowKeyDown({ event, item, onSelect });
  };

  return (
    <ControlHintTooltip title={item.label} side="right">
      <div
        ref={setNodeRef}
        style={style}
        aria-label={item.label}
        aria-selected={selected}
        data-state={selected ? "selected" : "idle"}
        data-testid={item.testId}
        data-disabled={rowDisabled ? "" : undefined}
        onClick={() => {
          if (rowDisabled) return;
          onSelect(item);
        }}
        {...attributes}
        {...listeners}
        onKeyDown={handleKeyDown}
        className={`${ROW_BASE_CLASS} cursor-grab touch-pan-y select-none active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${selected ? ROW_SELECTED_CLASS : ROW_IDLE_CLASS} ${isDragging ? "z-20 opacity-70" : ""} ${rowDisabled ? "pointer-events-none opacity-60" : ""}`}
      >
        <span className="shrink-0 text-current" aria-hidden="true">
          {item.icon}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 max-md:sr-only">
          <span className="min-w-0 truncate">{item.label}</span>
        </span>
        {item.trailing ? (
          <span className="shrink-0 max-md:hidden" aria-hidden="true">
            {item.trailing}
          </span>
        ) : null}
      </div>
    </ControlHintTooltip>
  );
}

function SortableSettingsNavGroup({
  group,
  selectedKey,
  disabled,
  onSelect,
  onReorderIds,
  reorderableKeys,
  sensors,
}: {
  group: SettingsSortableNavGroup;
  selectedKey: string | null;
  disabled?: boolean;
  onSelect: (item: SettingsSortableNavItem) => void;
  onReorderIds?: (ids: string[]) => Promise<void>;
  reorderableKeys?: ReadonlySet<string>;
  sensors: ReturnType<typeof useSensors>;
}) {
  const persist = useCallback(
    async (ids: readonly string[]) => {
      await onReorderIds?.([...ids]);
    },
    [onReorderIds],
  );
  const optimisticOrder = useOptimisticReorder({
    authoritativeIds: group.items.map((item) => item.key),
    persist,
  });
  const renderedItems = useMemo(() => {
    const itemByKey = new Map(group.items.map((item) => [item.key, item] as const));
    return optimisticOrder.renderedIds.flatMap((key) => {
      const item = itemByKey.get(key);
      return item ? [item] : [];
    });
  }, [group.items, optimisticOrder.renderedIds]);

  // 不传 onReorderIds 时退化为普通按钮组：不挂 DndContext，避免无意义的拖拽监听。
  if (!onReorderIds) {
    return (
      <div className="flex flex-col gap-1 max-md:items-center">
        {group.items.map((item) => (
          <SettingsSortableNavButton
            key={item.key}
            item={item}
            selected={item.key === selectedKey}
            disabled={disabled}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      modifiers={[restrictToVerticalAxis]}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        const activeKey = String(event.active.id);
        const overKey = event.over ? String(event.over.id) : "";
        if (!overKey || activeKey === overKey) return;
        const nextKeys = resolveReorderedKeys({
          activeKey,
          overKey,
          keys: optimisticOrder.renderedIds,
        });
        void optimisticOrder.commit(nextKeys).catch(() => undefined);
      }}
    >
      <SortableContext
        items={[...optimisticOrder.renderedIds]}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col gap-1 max-md:items-center">
          {renderedItems.map((item) => {
            const sortable = !reorderableKeys || reorderableKeys.has(item.key);
            if (!sortable) {
              return (
                <SettingsSortableNavButton
                  key={item.key}
                  item={item}
                  selected={item.key === selectedKey}
                  disabled={disabled}
                  onSelect={onSelect}
                />
              );
            }
            return (
              <SortableSettingsNavButton
                key={item.key}
                item={item}
                selected={item.key === selectedKey}
                disabled={disabled}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/**
 * 设置页共享可排序导航：供应商与模型组共用同一套行样式、拖拽与窄屏收纳。
 * 分组标题、状态点、图标全部由调用方通过 items 组装传入，本组件不识别任何业务语义。
 */
export function SettingsSortableNav({
  groups,
  selectedKey,
  disabled,
  onSelect,
  onReorderIds,
  reorderableKeys,
}: {
  groups: readonly SettingsSortableNavGroup[];
  selectedKey: string | null;
  disabled?: boolean;
  onSelect: (item: SettingsSortableNavItem) => void;
  onReorderIds?: (ids: string[]) => Promise<void>;
  reorderableKeys?: ReadonlySet<string>;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  return (
    <aside className="px-1.5 py-3 md:py-2 md:px-2">
      <div className="flex min-h-0 flex-col gap-3 max-md:gap-1">
        {groups.map((group) => (
          <div key={group.id} className="flex flex-col gap-2 max-md:gap-1">
            {group.title ? (
              <div className="flex h-7 items-center justify-between px-2 py-1 max-md:hidden">
                <h3 className="text-ui-sm font-semibold text-foreground-subtlest">{group.title}</h3>
              </div>
            ) : null}
            <SortableSettingsNavGroup
              group={group}
              selectedKey={selectedKey}
              disabled={disabled}
              onSelect={onSelect}
              onReorderIds={onReorderIds}
              reorderableKeys={reorderableKeys}
              sensors={sensors}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}
