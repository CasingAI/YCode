# Spec: Provider Primary 展示标记

## 目标

让用户为每个供应商单独标记是否为 Primary，模型选择器只按该标记决定一级展开。取代账号套餐（BigModel / Start Plan 等）按 access 自动一级展开的硬编码。

## 产品规则

- 用户在「供应商和模型」里为每个供应商单独标记是否为 Primary。
- **未设置或关闭时一律不是 Primary**，包括智谱账号套餐（BigModel / Start Plan 等）。这会改变当前账号套餐固定一级展开的行为：升级后若用户不勾选，它们会和其他供应商一样进入二级菜单。
- Primary 只影响模型选择器展示，不改变启用、可执行、凭据、排序设置或 Registry 成员资格。
- 关闭供应商后 Primary 标记仍保留；重新开启后按已保存标记展开。
- 隐藏的 Off-Peak 供应商不出现在普通选择器，也不因本规则改变可见性。

选择器展示：

- Primary：组标题（账号套餐仍可带「个人 / 免费」等徽章）+ 模型平铺在一级。
- 非 Primary：组名进入带箭头的二级菜单。
- 选择器内把 Primary 组排到前面，组内与组间仍沿用现有供应商顺序；设置页列表顺序不变。
- 分割线跟着 Primary 一级平铺分组走：平铺分组与相邻分组之间（无论邻居是另一个平铺组还是二级菜单组）始终有分割线；二级菜单组之间沿用既有 family 连接组分隔规则，不额外加线。

```text
用户切换 Primary
  → 既有 savePersonalProviderOverlay（metadata 稀疏补丁）
  → Personal Provider 配置原子持久化
  → Resolver 刷新 Settings / Registry
  → ModelSelection 投影 isPrimary
  → 选择器按标记展开或收进二级菜单
  ↛ 可执行性 / 账号权益 / OAuth / 凭据
```

## 状态所有者与事件顺序

与 [provider-disable.md](provider-disable.md) 的 `enabled` 同层：挂在 **Provider Rule**，不写进执行配置体。

- 所有者：`ProviderConfigService` 的个人覆盖层（`~/.zcode/v2/provider_config.json`）。
- 缺省：未写字段视为 `false`。
- Overlay 合并与 `enabled` 相同：个人层覆盖内置层；内置配置不预置 Primary。

## 负面边界

- 不删除或改写 Built-in Provider 定义。
- 不修改 OAuth 登录、账号权益轮询或凭据存储。
- 不把展示偏好写进 Registry 执行语义：`isPrimary` 不参与 `executable` / `selectable` / Registry 发布判定，只随视图投影透传。
- 不调整设置页列表顺序与拖拽顺序。
- 不改变隐藏 Off-Peak 供应商的可见性规则。
- 不预置任何内置 Primary；不改造 `ModelConfigSelect.tsx` 的渲染组件，只改分组输入。

## 验收场景

1. 全新配置：全部供应商在选择器里都是二级菜单。
2. 勾选某第三方供应商为 Primary：其模型一级展开，并排在选择器前部。
3. 勾选账号套餐为 Primary：外观回到现在的标题 + 徽章 + 一级模型。
4. 刷新/重启后标记仍在；保存失败时界面回到服务端状态。
5. 关闭供应商后它离开选择器，但 Primary 标记还在；再开启后仍按标记展开。
6. Primary 不改变连通性、额度、启用或设置页拖拽顺序。
