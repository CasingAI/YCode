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
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 模型组成员拖拽排序（docs/specs/model-group.md）：
// - 重复成员由调用方用出现序号生成唯一 id，本组件只消费 id，不识别模型身份；
// - 拖拽手柄是唯一的排序入口，桌面拖动与键盘（空格抓起 / 方向键移动 / 空格放下）
//   都从这颗按钮发起，行内其它控件保持原有单击语义；
// - 排序只改变 memberOrder 下标，不表达优先级，写入仍由 setModelGroupMembers 承担。

// 成员列表只做纵向排序，拖动时锁定 x=0，避免横向漂移。
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export function ModelGroupMemberSortableList({
  ids,
  disabled,
  onReorder,
  className,
  children,
}: {
  ids: readonly string[];
  disabled?: boolean;
  onReorder: (nextIds: readonly string[]) => void;
  className?: string;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <DndContext
      sensors={sensors}
      modifiers={[restrictToVerticalAxis]}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        const activeId = String(event.active.id);
        const overId = event.over ? String(event.over.id) : "";
        if (!overId || activeId === overId) return;
        const activeIndex = ids.indexOf(activeId);
        const overIndex = ids.indexOf(overId);
        if (activeIndex < 0 || overIndex < 0) return;
        onReorder(arrayMove([...ids], activeIndex, overIndex));
      }}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy} disabled={disabled}>
        {/* 列表容器由本组件渲染：dnd-kit 的隐藏无障碍节点与 <ul> 同级，
            不能落进 <ul> 里造成 ul > div 的非法嵌套。 */}
        <ul className={className}>{children}</ul>
      </SortableContext>
    </DndContext>
  );
}

export function ModelGroupMemberSortableRow({
  id,
  disabled,
  className,
  children,
}: {
  id: string;
  disabled?: boolean;
  className?: string;
  children: (handle: ReactNode) => ReactNode;
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
  } = useSortable({ id, disabled });

  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      disabled={disabled}
      aria-label={intl.formatMessage({ id: "settings.modelGroups.memberDragHandle" })}
      title={intl.formatMessage({ id: "settings.modelGroups.memberDragHandle" })}
      data-model-group-member-drag-handle={id}
      className="flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-foreground-subtlest outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-60"
      {...attributes}
      {...listeners}
    >
      <GripVertical aria-hidden="true" className="size-3.5" />
    </button>
  );

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`${className ?? ""} ${isDragging ? "relative z-20 opacity-70" : ""}`}
    >
      {children(handle)}
    </li>
  );
}
