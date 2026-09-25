# Spec: Provider 可关闭语义

## 目标

让智谱账号/套餐 Provider 与普通第三方 Provider 使用一致的用户关闭开关。关闭只阻断 Provider 及其模型进入执行链路，不清空 Provider、模型、账号配置或凭据。

## 产品规则

- 普通 Provider 和 `zhipu-account` Provider 都使用 Provider Rule 的 `enabled` 字段；未设置时默认为 `true`。
- 设置页中可见的智谱账号/套餐 Provider 显示 Provider 总开关，关闭后仍保留 Provider 卡片、模型列表和账号 access。
- Provider 卡片为了避免重复标题而隐藏 Header 时，仍须在 Provider 家族标题同一行的右侧操作区显示且只显示一个 Provider 总开关；是否渲染卡片由详情页依据实际 Provider 配置和权益决定，不在没有卡片的状态下凭空渲染开关。
- 家族标题、连接模式和 Provider 总开关必须保持在同一个不换行的 Header 行中；空间不足时优先压缩或截断标题与连接模式文本，Provider 总开关不得单独掉到下一行。
- `enabled: false` 会使 Provider 及其模型变为不可执行、不可选择，并阻止 Provider 发布到执行 Registry；不会从 Settings View 删除配置。
- 账号权益和当前连接状态仍独立参与可用性判断。重新开启 Provider 后，只有在账号已连接、权益有效且模型配置有效时，模型才恢复可执行。
- 关闭 Provider 不等于退出账号、清空 API Key/OAuth/Coding Plan 凭据、删除模型、删除历史会话或停止所有智谱网络活动。
- 隐藏的 Off-Peak Provider 不因本规则出现在普通设置页；其独立调度和可见性语义保持不变。
- 关闭操作通过既有 Provider Overlay 保存入口提交；保存失败时保留服务端权威状态，不提交半成品。
- `ProviderSettingsView.revision` 只表示设置投影版本，不表示账号身份或权益版本；仅修改 Provider `enabled` 不得触发 Account Provider Resolver、OAuth token 读取或 Coding Plan 权益请求。
- 登录、登出、Built-in 配置变化、账号连接变化和套餐身份变化仍沿用原有账号与权益刷新路径；独立周期轮询不因本规则改变。
- 关闭 Provider 不改变账号套餐身份。官方 Server MCP 的身份头与只读额度归属从 Provider 设置投影加账号事实解析，不读执行 Registry；关闭 Provider 后官方 MCP 额度项仍按原口径显示。
- 关闭 Provider 不触发套餐类查询。账号事实指纹（`access` + `accountState` + 连接选择）未变时，购买入口的权益与企业套餐定价查询、闲时套餐资格查询都不得重新发起，购买入口也不得进入 loading。

## 状态所有者与事件顺序

- Built-in 配置拥有账号 Provider 的 `access`、账号类型、套餐模式、内置模型和默认规则。
- Personal Provider 配置拥有用户对 Provider Rule 的 `enabled` 覆盖；它不能改写固定账号 Provider 的 `access`。
- `ProviderConfigResolver` 负责合并 Built-in、Personal 和账号状态，并生成 `resolvedProviders` 与 `registryProviders` 两个视图。
- `registryProviders` 是模型执行和 Agent readiness 的唯一来源；`resolvedProviders` 是设置页配置投影，不能互相替代。
- 账号套餐身份（官方 Server MCP 身份头、只读 MCP 额度归属）由设置投影中的 `effectiveConfig.access` 加账号事实 `entitled` + `current` 决定；官方 MCP 身份是产品级单例（`oauth:active_provider`），因此候选按当前激活的 Provider family 收口，不受 Provider `enabled` 影响。

```text
用户切换开关
  → 既有 savePersonalProviderOverlay
  → Personal Provider 配置原子持久化
  → Provider Registry Resolver 刷新
  → Settings View 保留配置并显示 disabled
  → registryProviders / 模型选择 / Agent readiness 排除该 Provider
  ↛ Account Provider Resolver / OAuth token / Coding Plan entitlement
```

账号或 Built-in 事实变化走另一条链：

```text
账号/Built-in 事实变化
  → Account Provider Service 刷新
  → Account Snapshot 更新
  → Registry 组合新的账号事实
  → 权益、购买 token 和登录态按既有业务入口刷新
```

`ProviderSettingsView.revision` 仍用于设置投影顺序、保存结果提交和模型草稿冲突保护，但不能再作为账号或权益刷新信号。`refreshSources` 仍只属于显式手动刷新路径，不能被 Provider enabled 保存隐式调用。

- 关闭 Provider 只影响执行链路，套餐身份链路保持不变：

```text
用户关闭 Coding Plan Provider
  → 个人配置 enabled=false
  → registryProviders 排除该 Provider（模型执行、Agent readiness 生效）
  → resolvedProviders 仍保留 access + accountState
  → 官方 MCP 身份头与 /api/v1/mcp/usage 额度归属照常解析（entitled + current 判定）
  → 账号事实指纹不变
  ↛ 权益查询 / 企业套餐定价 / 闲时套餐资格
```

## 负面边界

- 不删除或改写 Built-in Provider 定义。
- 不修改 OAuth 登录、账号权益轮询、购买入口或凭据存储。
- 不把 Provider 禁用实现成退出账号或清空账号域。
- 不按模型名全局过滤，避免误伤其他 Provider 提供的同名 GLM 模型。
- 不新增第二套 Provider 状态、RPC 或模型选择过滤逻辑。
- 不因修复额度归属而把已关闭的 Provider 放回执行 Registry。
- 不放宽官方 MCP 的归属校验：family、Personal/Team 和 organization/project 仍必须与本次查询一致，不匹配就不发请求；解析不到 scope 时不伪造 0% 额度卡。
- 不把 Settings View 对象身份或 `revision` 当作套餐、购买、闲时资格类查询的触发条件与结果身份；这些链路统一使用账号事实指纹。
- 不因省掉查询而丢失首次加载：视图未就绪与账号事实为空是两种状态，后者仍要完成首次团队套餐查询。

## 验收场景

1. 已登录且有权益的可见智谱账号/套餐 Provider 显示总开关，关闭后卡片、账号 access、模型和配置仍保留。
2. 关闭后 Provider 和模型不出现在执行模型选择中，连通性测试在发起网络请求前返回 Provider 不可用。
3. 刷新页面或重启后关闭状态仍保留；重新开启后，权益和当前连接有效时模型恢复可用。
4. 关闭、重新开启和账号状态变化都不会删除模型、凭据或用户已有的 Personal Overlay。
5. 普通第三方 Provider、隐藏 Off-Peak Provider 和远程环境的其他状态不因本规则改变。
6. 关闭唯一一个有权益的 Coding Plan Provider 后，套餐卡中的官方 MCP 额度项仍显示并随权益刷新；family 或 Team 组织归属不匹配时仍不发请求、不显示额度项。
