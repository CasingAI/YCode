# Spec: 设置页主从共享组件（可排序导航 + 详情头菜单）

## 目标

供应商页（`modelProvider`）与模型组页（`modelGroups`）的左侧导航与详情头部在视觉上必须完全一致，但两边各自手写了一套：供应商用 `model-provider-section/Navigation.tsx`（dnd-kit 拖拽 + 分组 + 状态圆点），模型组用 `ModelGroupsSection.tsx` 内的手写 `<ul><button>`（箭头排序 + 首字圆点）。头部同样各写各的：供应商是 `ProviderCardHeader`（标题 + `...` 菜单：重命名 + 红色删除），模型组是标题 + 可见的「重命名」按钮 + 红色「删除模型组」按钮。本 spec 把两块抽成 `packages/ui/src/settings/` 下的公共组件，两边都迁移过去，不再各写一套。

此前抽过 `SettingsMasterDetailLayout`（栅格外壳）与 `SettingsResourceHeaderActions`（右上新建按钮），但导航行与详情头没抽，导致两页越长越像、代码越差越多。

## 产品规则

### 共享导航 `SettingsSortableNav`

- 新建 `packages/ui/src/settings/SettingsSortableNav.tsx`，对外只认通用条目，与供应商/模型组语义解耦：

```ts
interface SettingsSortableNavItem {
  readonly key: string; // 选中比对 + dnd sortable id（供应商传 providerId，模型组传 groupId）
  readonly label: string; // 行主文案（tooltip + aria-label 同源）
  readonly testId: string; // 行 data-testid，两边各传各的前缀，不得共用
  readonly icon: ReactNode; // 行首图标：供应商传 ProviderLogo，模型组传 Layers
  readonly trailing?: ReactNode; // 行尾点缀：供应商传 ProviderStatusIndicator，模型组传成员数或不传
  readonly disabled?: boolean; // loading 占位等不可点行
}
```

- 分组为可选：`groups: readonly { id, title?, items }[]`；单组调用方直接传一组即可。供应商现状的三组（预置 / OpenCode / 自定义）与分组标题、loading 转圈保留在供应商侧组装，不进公共组件。
- 排序为可选：传 `onReorderIds(ids)` 才启用 dnd-kit 拖拽（`DndContext + SortableContext verticalListSortingStrategy`、纵向 `restrictToVerticalAxis`、`PointerSensor distance:6 + KeyboardSensor`，与供应商现有参数一致）；不传则渲染普通按钮行。拖拽持久化复用现有通用 hook `useOptimisticReorder`（`model-provider-section/useOptimisticReorder.ts`，逻辑与 Provider 无关，本次把它搬到 `packages/ui/src/settings/useOptimisticReorder.ts`，原路径保留 re-export）。
- 行视觉与供应商现有行逐像素一致：`h-8 rounded-lg border px-2`、未选中 `border-transparent hover:border-border-hover/60`、选中 `border-border-hover bg-card-selected`、窄屏 `max-md:size-8` 只留图标（文案 `sr-only`）。tooltip 统一 `ControlHintTooltip title side="right"`。
- 模型组迁移后：行首统一 Layers 图标（不再用首字圆点），行尾成员数保留；左栏 hover 箭头排序删除，改走拖拽；窄屏排序不再需要详情区那组备用箭头，一并删除。

### 共享详情头 `SettingsDetailHeaderMenu`

- 新建 `packages/ui/src/settings/SettingsDetailHeaderMenu.tsx`，结构照抄供应商 `ProviderCardHeader` 的右侧部分：标题区（`leading` 节点 + 标题文案 + 可选内联改名输入） + 右侧 `...` 菜单（`DropdownMenu`：重命名项 + `Separator` + `variant="destructive"` 删除项）。调用方通过 props 传入文案与回调，不在组件内写死任何供应商/模型组 key：

```ts
{
  title: string;
  titleTestId?: string;
  leading?: ReactNode; // 供应商传 ProviderLogo，模型组不传
  trailing?: ReactNode; // 供应商传启用开关，模型组不传
  renameLabel: string; // 供应商传 renameProvider，模型组传 rename
  onRename: () => void;
  onDelete?: () => void;
  deleteTestId?: string;
  menuTestId?: string;
}
```

- 模型组迁移后：详情头部的「重命名」可见按钮与红色「删除模型组」按钮删除，收进 `...` 菜单；删除确认继续走现有 `useConfirmDialog` + `deleteConfirmTitle/Description`，行为不变。供应商侧本次不动（仍用 `ProviderCardHeader`），只保证新组件视觉一致，后续再迁。
- `ProviderCardHeader` 本次保留不动，不改其 testid/i18n，避免供应商回归。

### 详情卡片分段与成员选择弹窗（模型组详情对齐供应商卡片）

- 详情区不再套第二层内边距：`SettingsMasterDetailLayout` 详情插槽自带 `p-4 sm:p-6`，内容根用 `space-y-3` 纵向堆叠（与 `InlineEditableProviderCard` 内容区一致），禁止再套 `gap-4 p-4`。
- 成员段结构对齐供应商 Models 区：区头为标题左置 + 右上 `secondary` 添加按钮；列表容器 `overflow-hidden rounded-lg border border-input-border bg-input`；空态为虚线 `h-12` 行；成员行对齐 `ModelRowInput`（`px-3 py-2`、左侧 mono id + 可用性徽标、右侧操作组 `ml-auto`，拖拽排序沿用各页现有顺序方法）。
- 添加成员走弹窗 `ModelGroupMemberPickerDialog`（`packages/ui/src/settings/` 下新文件）：小窗宽度沿用组新建窗 `sm:max-w-[420px]` 口径；数据源沿用各页现有成员候选（设置面 `ProviderSettingsView` 投影，不吃执行面选择视图）；分组按供应商打组；渲染复用纯展示选择器；选中映射回 `{providerId, modelId}` 二元组提交；不可用成员置灰仍展示（沿用 `memberUnavailable` 语义）；组自身永不出现在候选中（禁止组套组）。测试 ID 前缀 `model-group-member-picker-*`，与新建窗 `model-group-create-dialog*` 隔离。

### 状态所有者与接口

- 排序唯一写入者不变：供应商仍是各自分组持久化回调，模型组是 `reorderModelGroups(groupIds)`；公共组件只负责拖拽交互 + 经 `useOptimisticReorder` 做乐观呈现，不拥有任何业务状态。
- 删除确认仍走 `useConfirmDialog` 全局 store，两边 payload 各用各的（供应商 `modelProviderActions` 守卫保留，模型组现有 `handleDelete` 直接给菜单 `onSelect`）。
- `SettingsMasterDetailLayout` 栅格（56px/`md:224px`）与 `SettingsMasterNavigation` 滚动外壳不变；新组件只替换插槽内容，不动外壳。
- 测试 ID 命名空间隔离：供应商沿用 `TID_MODEL_PROVIDER_NAV_ITEM`，模型组沿用 `model-group-nav-<groupId>` 与 `model-group-create-dialog*`；新组件只透传调用方给的 testId，不内置任何前缀。

## 事件顺序

```text
抽取 SettingsSortableNav + SettingsDetailHeaderMenu（新文件，无调用方）
  → useOptimisticReorder 搬到 settings/，原路径 re-export
  → 模型组导航迁到 SettingsSortableNav（拖拽排序 + Layers 图标）
  → 模型组详情头迁到 SettingsDetailHeaderMenu（重命名/删除收进 ... 菜单）
  → 供应商侧本次不动（只读回归），后续再迁
```

## 负面边界

- 供应商 `Navigation.tsx`、`ProviderCardSections.tsx` 的 `ProviderCardHeader` 本次不动：只新增公共组件 + 迁移模型组，不重构供应商，避免大面积回归。
- 模型组成员行内的上下箭头（成员排序）本次不动：只统一左栏组排序与详情头，成员排序交互另议。
- 新建 Dialog 小窗（`model-group-create-dialog`）本次不动，已是对齐过的系统组件。
- 不新增 Drawer、自动保存、分组标题样式；`SettingsMasterDetailLayout` 栅格与断点不动。
- CLI/runtime、抽选钉死、横幅、失败 ACK 一律不动，纯 UI 层抽取。

## 验收场景

1. 模型组左栏行与供应商行视觉一致：同高（h-8）、同圆角边框、选中同为 `bg-card-selected`；行首为 Layers 图标，行尾成员数；hover 箭头消失，拖拽可排序，松手后顺序持久化且刷新不回跳。
2. 模型组详情头与供应商头一致：标题 + 右侧 `...` 菜单；菜单里「重命名」点击进入改名态，「删除」为红色项，点击后弹出已有确认框，确认后删除。
3. 窄屏（375px）：左栏只留图标可点选，详情区备用排序箭头已删除（拖拽在触屏可用）；详情头菜单不溢出。
4. 供应商页 768px/1440px 逐像素不变：导航、头部、拖拽、删除确认行为与改动前一致。
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；`settingsPageConfig.test.ts` 通过。

## 验证

- `useOptimisticReorder` 搬家后原路径 re-export，供应商拖拽单测（如有）照常通过。
- 模型组导航拖拽与详情头菜单补组件级用例或沿用现有设置页单测入口（以 `packages/ui` 现有 `package.json` 测试入口为准）。
- 不用 CDP 操作 YCode。
