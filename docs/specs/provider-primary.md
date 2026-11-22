# Spec: 模型展示权重（Provider 展示分层）

## 目标

把供应商一级展示标记从布尔 Primary 扩展为三态「模型展示权重」：用户为每个供应商选择模型选择器中的展示层级——一级展开（`expanded`）、独立二级菜单（`submenu`）或收进菜单末尾的「其他」组（`other`）。取代账号套餐（BigModel / Start Plan 等）按 access 自动一级展开的硬编码，并兼容旧盘 `isPrimary` 数据。

## 产品规则

- 设置项名为「模型展示权重」，每个供应商三选一：
  - `expanded`：展开显示（一级平铺并置前）；
  - `submenu`：作为二级菜单（缺省值）；
  - `other`：收进其他。
- **缺省一律 `submenu`**，包括智谱账号套餐（BigModel / Start Plan 等）。旧盘未写 `displayMode` 但 `isPrimary === true` 的供应商派生为 `expanded`（见「持久化与兼容」）。
- 三态只影响模型选择器展示层级，不改变启用、可执行、凭据、排序设置或 Registry 成员资格。
- 关闭供应商后权重保留；重新开启后按已保存权重展示。
- 隐藏的 Off-Peak 供应商不出现在普通选择器，也不因本规则改变可见性。

## 选择器展示规则

- `expanded` 组：组标题（账号套餐仍可带「个人 / 免费」等徽章）+ 模型平铺在一级，并排到选择器前部；组内与组间沿用现有供应商顺序，设置页列表顺序不变。
- 分割线跟着 `expanded` 一级平铺分组走：平铺分组与相邻分组之间（无论邻居是另一个平铺组还是二级菜单组）始终有分割线；`submenu` 组之间沿用既有 family 连接组分隔规则，不额外加线。
- `submenu` 组：组名进入带箭头的独立二级菜单。
- `other` 组：`displayMode=other` 的供应商全部收进菜单末尾一个可展开的合成「其他 >」入口，固定三层，分节标题不算菜单层级：
  - 第一层（主菜单）：只出现「其他 >」入口，不出现任何 other 供应商名，也不出现模型；
  - 第二层（进入「其他 >」后）：只出现供应商入口（`<供应商名> >`），不出现模型；供应商不能用灰色标题/`DropdownMenuLabel` 代替入口；
  - 第三层（再展开供应商入口后）：只出现该供应商自己的模型条目。
  - 层级不随数量扁平化：只有一个供应商、或供应商只有一个模型时仍然保留三层；没有任何 `other` 供应商时不渲染「其他」入口。
  - 当前选中模型属于某个 other 供应商时，「其他」入口与该供应商入口两个上级触发器都显示选中勾选（按合成组的平铺 `items` 索引命中，平铺数据只用于触发器解析与选中态，不参与第二层渲染）。
  - 第三层子菜单内容必须通过 `DropdownMenuPortal` 挂到第二层 `DropdownMenuSubContent` 的 DOM 子树之外（第三个 `DropdownMenuSubContent` 外层包 `DropdownMenuPortal`），否则会被第二层 `DropdownMenuSubContent` 的 `overflow-x-hidden` / `overflow-y-auto` 裁剪；只包必要层级，不改全局菜单基础组件，也不靠 z-index、取消滚动或定时器掩盖。
  - 「其他」入口排在所有供应商分组与「模型组」分节之后（`withModelGroupSection` 在 other 组之前插入「模型组」分节，见 [model-group.md](model-group.md)），入口前有分割线。
  - 宽屏的侧向展开和键盘左右导航沿用 Radix；窄屏的呈现与返回规则见下文。两种布局都保留选中、点击外部和 Esc 关闭菜单的行为。

文字树（宽屏每层各有一个面板，窄屏逐层替换同一面板的内容）：

```text
主菜单
├─ 供应商 A >            (expanded/submenu 原有行为)
├─ 模型组 >
└─ 其他 >                (第一层：只有这个入口)
   ├─ Provider X >      (第二层：供应商入口，不是灰色标题)
   ├─ Provider Y >
   └─ Provider Z >
      ├─ model-1        (第三层：展开任一供应商后只出现它自己的模型)
      └─ model-2
```

## 子菜单窄屏呈现

- 按现有窄屏断点（小于 768px）切换布局，包含手机 Web 与窄桌面窗口。普通供应商和「其他」都在同一菜单面板内逐级进入，不再向两侧弹出。平铺组和首层操作的位置不变。
- 面板保持在视口内，列表超出可用高度时可滚动。每个子层都有返回入口；键盘可激活该入口，返回后焦点回到原入口。Esc 或点击外部关闭整个菜单，重新打开从首层开始。
- `ModelConfigSelect` 只记录本次打开的导航路径，根据当前分组解析；关闭菜单、切换到宽屏，或首层分组不再可用时退出子层。不改变模型值、分组数据或持久化。宽屏继续使用原有侧向菜单的宽度、8px 碰撞间距与 Radix 键盘交互。

```text
进入 / 返回 → ModelConfigSelect 更新当前层与焦点（不选择模型）
选择模型   → 现有选择回调 → 关闭菜单 → 清除导航路径
```

验收：在 320–480px 视口从靠右的触发器打开菜单。普通账号和「其他 > 供应商 > 模型」每层都只有一个视口内的面板，模型可以点选。返回、关闭后重开以及键盘操作不会改变已选模型。

## 持久化与兼容

与 [provider-disable.md](provider-disable.md) 的 `enabled` 同层：挂在 **Provider Rule**，不写进执行配置体。

- 所有者：`ProviderConfigService` 的个人覆盖层（`~/.zcode/v2/provider_config.json`）。
- 新写入只写 `displayMode`，不再写 `isPrimary`。
- 旧盘 `isPrimary` 只读兼容：不删除、不迁移、不逐组改写；不做 schemaVersion 升版（additive 可选键，先例见 `modelGroupsPrimary`）。
- 派生规则（唯一派生源 `resolveProviderDisplayMode`，`packages/provider/src/config/rule-data-schema.ts`）：
  1. `displayMode` 已写 → 用它；
  2. 未写但旧 `isPrimary === true` → `expanded`；
  3. 都没有 → `submenu`。
- Overlay 合并与 `enabled` 相同：个人层覆盖内置层；内置配置不预置 `displayMode`。

## 状态所有者与事件顺序

```text
用户切换模型展示权重
  → 既有 savePersonalProviderOverlay（metadata 稀疏补丁，只写 displayMode）
  → Personal Provider 配置原子持久化
  → Resolver 刷新 Settings / Registry
  → ModelSelection 投影 resolveProviderDisplayMode
  → 选择器按权重展开 / 收进二级菜单 / 收进「其他」
  ↛ 可执行性 / 账号权益 / OAuth / 凭据
```

## 负面边界

- 不删除或改写 Built-in Provider 定义。
- 不修改 OAuth 登录、账号权益轮询或凭据存储。
- 不把展示偏好写进 Registry 执行语义：`displayMode`（及其兼容派生输入 `isPrimary`）不参与 `executable` / `selectable` / Registry 发布判定，只随视图投影透传。
- 不逐组迁移旧 `isPrimary`，不做 schemaVersion 升版；旧字段保留只读。
- 不调整设置页列表顺序与拖拽顺序。
- 不改变隐藏 Off-Peak 供应商的可见性规则。
- 不预置任何内置展示权重，不改变 `expanded` / `submenu` / `other` 的分组和顺序。

## 验收场景

1. 全新配置：全部供应商缺省 `submenu`，都在选择器里作为二级菜单。
2. 把某供应商设为 `expanded`：其模型一级展开、排在选择器前部，平铺分组与相邻分组之间有分割线。
3. 把某供应商设为 `other`：其模型收进菜单末尾的「其他 >」入口——第一层主菜单只有「其他 >」，进入后第二层只出现供应商入口（如「OpenCode Go (Chat) >」「Command Code >」「MiniMax Token Plan >」），没有模型条目；再进入供应商才在第三层看到它自己的模型；「其他」入口排在所有供应商分组与「模型组」分节之后，入口前有分割线。
4. 所有供应商都设为 `other`、且只有一个供应商或每个供应商只有一条模型时，交互层级仍是「其他 >」→ 供应商入口 → 该供应商模型三层，不自动平铺成两层。
5. 当前选中模型属于某个 other 供应商：「其他」入口与该供应商入口都显示选中勾选；选中模型后菜单按 Radix 原生行为关闭。
6. 没有供应商设为 `other`：菜单不出现「其他」入口。
7. 设回 `submenu`：恢复独立二级菜单。
8. 刷新/重启后权重仍在；保存失败时界面回到服务端状态。
9. 旧盘 `isPrimary === true` 升级后：未写 `displayMode` 时仍按 `expanded` 一级展开；一旦写入 `displayMode` 即以新字段为准。
10. 三态不改变连通性、额度、启用或设置页拖拽顺序。
11. 手机 Web 窄屏逐级进入普通账号或「其他 > 供应商 > 模型」：当前层留在视口内，可返回、滚动和选中（见「子菜单窄屏呈现」）。

## 验证

- 后端持久化、派生与投影：`packages/provider/test/providerPrimary.test.ts`
- 选择器分组与分割线：`packages/ui/test/providerPrimaryGroups.test.ts`
- 「其他」三层菜单结构与真实菜单交互：`packages/ui/test/modelSelectOtherGroupLevel.test.ts`（源码契约 + 独立无头 Chromium 渲染回归；未安装独立 Chromium 时该用例显式跳过，并如实报告）
