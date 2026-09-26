# Spec: 侧边栏一级导航的「更多」下拉

## 目标

侧边栏顶部一级导航原来有四行平铺按钮：新建任务 ⌘N、搜索 ⌘K、自动化、插件市场。前两个是高频动作，后两个是低频功能入口，但四者享受同样的视觉权重、位置和整行点击面积。一级导航应当只承载高频动作。

本次把自动化和插件市场收进一个「更多」下拉，一级导航只剩两行。

## 产品规则

### 分层

- 一级导航保留**新建任务**和**搜索**两行，顺序、样式、快捷键标签、tooltip 均不变。
- 自动化与插件市场收进第三行的**「更多」**下拉，是一级导航下的唯一一组次级入口。
- 用普通下拉菜单，**不引入二级菜单（submenu）**。本组只有两个平铺项，再套一层子菜单会多一次悬停、减少可见项，是纯粹的负收益。
- 文案复用既有的 `common.more`（`zh-CN.ts` / `en-US.ts` 均已存在），不新增 i18n key。

### 可发现性的已知代价

自动化和插件市场**没有命令面板入口，也没有快捷键**——`quickPick/quickPickCommands.ts` 的 19 条命令里没有任何一条指向它们。折叠前，侧栏按钮是唯一入口；折叠后，唯一的后备路径变成「齿轮 → 设置页 → Agent 能力组 → 自动化 / 插件」（`settings/settingsPageConfig.ts` 中两个分区同属 `agentCapabilities` 组）。

本次不补命令面板入口、不加快捷键，因此接受这次可发现性下降。这是有意识的取舍，不是遗漏。

### 选中态

折叠前，自动化和插件市场各自是整行按钮，用 `aria-pressed` + `bg-selected` 表达「当前主视图就是这一项」。折叠后这个信号不能丢：

- **触发器承载分组级信号**：`automationsActive || pluginStoreActive` 为真时，「更多」按钮带 `bg-selected text-foreground`，复用既有 class，不新增 token。语义是「这一组里有东西是当前主视图」，与折叠前「这一项高亮」在视觉上一致。
- **菜单项承载项级信号**：两个菜单项用 `DropdownMenuCheckboxItem` + `checked={...}`，当前所在项在右侧显示 `CheckIcon`。展开菜单即可看清自己在哪一项，不必靠触发器猜。

选 `CheckboxItem` 而不是 `RadioItem`：菜单并未穷举全部主视图（会话视图不在其中），`RadioGroup` 会谎称这是一个封闭集合。`CheckboxItem` 表达的是「这个目的地就是当前所在处」，语义诚实。

### 浮层层级

`DropdownMenuContent` 走 portal 且固定 `z-[60]`，高于窄屏抽屉的 z-19 和顶部浮层的 z-20。侧边栏底部的同类下拉已在抽屉形态下正常工作，模式是现成复用的，不新增层级规则。

### 窄屏抽屉

`workspace-shell-responsive-layout.md` 规定「抽屉里的导航动作完成后收起抽屉」，自动化与插件市场都在该名单内。侧栏只是原样透传回调，收起逻辑仍由 `WorkspaceShellLayout` 的 `handleOpenAutomationsFromSidebar` / `handleOpenPluginStoreFromSidebar` 持有，**本次不改动这条链路**。

### 宽度

`DropdownMenuContent` 的宽度按内容撑开，不绑定 `--radix-dropdown-menu-trigger-width`——共享组件的注释已写明：图标按钮触发器会被 `min-w-32` 卡死在 128px，导致长文案折行。本组两项文案很短，按内容撑开即可。

## 状态所有者与事件顺序

主视图的唯一所有者仍是 `workspaceMainView`，**不变**。`automationsActive` / `pluginStoreActive` 仍由 `WorkspaceShellLayout` 从它派生后传给侧栏，侧栏不持有主视图状态。

「更多」下拉的开合是 Radix 内部状态，**不进 zcode store**。

```
点「更多」
  → Radix 开菜单（焦点进菜单；Esc / 点外部 / 选中任一项即关）
  → 选「自动化」
    → onSelect 调 handleOpenAutomationsMain
      → onOpenAutomations?.()
        → WorkspaceShellLayout.handleOpenAutomationsFromSidebar
          → ① 写主视图 workspaceMainView
          → ② collapseSidebarAfterNavigation()   ← 仅窄屏抽屉形态生效，内联列不收
    → Radix 自动关菜单
```

② 发生在 ① 之后、不替代 ①，与 `workspace-shell-responsive-layout.md` 里「收起动作跟在导航动作之后，不替代它」的既有口径一致。

## 边界

不做：

- 不动新建任务 / 搜索两行。
- 不补命令面板入口，不加快捷键。
- 不引入二级菜单。
- 不改侧边栏底部头像菜单（那里是语言 / 主题 / 界面模式 / 缩放 / 用量这类偏好设置，混入功能导航语义不一致）。
- 不改折叠态导轨 `WorkspaceSidebarCollapsedRail`。
- 不改设置页里自动化 / 插件分区的位置或分组。
- 不改闲时分组「+」打开自动化的路径。
- 不动 `pluginNavigationOrigin` / `pluginTab` / `pluginScopeKey` 这套 pending 导航状态机制。
- 不改 `TID_AUTOMATIONS_OPEN` / `plugin-store-sidebar-open` 的取值，只搬家。
- 不新增 CSS token、不改 `DESIGN.md`。

已知副作用：两个 `data-testid` 现在位于关闭状态的下拉菜单内，DOM 查询必须先展开菜单才能命中。当前仓库没有测试引用它们，但外部脚本若有依赖会受影响——这是把入口折叠进菜单的固有代价。

## 验收场景

宽视口（≥768px）：

1. 一级导航只剩两行（新建任务 / 搜索），第三行是「更多」。
2. 点「更多」弹出两项：自动化、插件市场；Esc 和点外部都能关。
3. 进入自动化页后，「更多」按钮带选中背景；展开菜单时「自动化」项右侧打勾、插件项不打勾。插件市场页同理。
4. 从菜单进自动化 / 插件市场，落地的主视图与改动前完全一致（含 `pluginNavigationOrigin` 带来的返回行为）。

窄视口（<768px）：

5. 从抽屉里点「更多」→ 选自动化 → **抽屉自动收起**（`workspace-shell-responsive-layout.md` 既有不变式，不得回归）。
6. 宽视口下同一路径**不**收起侧栏。
