# Spec: Provider 模型删除

## 目标

让用户可以把任意模型从某个 Provider 中删除，无论该模型来自内置定义还是用户自己添加。删除后该模型在这个 Provider 中不再存在：设置列表、模型选择和执行 Registry 里都没有它，重启后也不会回来。

实现上只保留一个概念：每个 Provider 记录一份 `excludedModelIds`，表示"这个 Provider 里被永久删除过的模型 ID"。系统在解析某个 Provider 有哪些模型 ID 的最早一步就把它减掉，此后所有上层拿到的都是过滤后的最终名单。

## 产品规则

- 所有模型行都显示删除入口。
- 删除 Personal Model 时，从当前 Provider 的 `personalModelIds`、`modelOrder` 和该 `(providerId, modelId)` 的 exact model rule 中移除，并写入 `excludedModelIds`。
- 删除 Built-in Model 时，不改写内置源，只写入当前 Provider 的 `excludedModelIds`，并清理该模型的 Personal exact rule。
- `excludedModelIds` 是 Provider 作用域的永久删除记录，不是可见性开关，不提供恢复或撤销。
- 系统解析某个 Provider 的模型成员时，必须先减去 `excludedModelIds`，再进入去重、排序、配置解析和 Registry 构建。
- 因为过滤发生在成员解析的最早步骤，上层不存在"被删除的模型"这个概念：设置列表、模型选择、模型排序和同名判重都只看到过滤后的名单，不会出现"看不见却占着名字"的模型。
- 删除操作不因为模型来源而分支；Personal 和 Built-in 走同一个事务。
- `excludedModelIds` 只做去重，不按当前内置名单裁剪。内置源以后重新声明同一个 ID 时，它仍然是删除状态。
- 另一个 Provider 的同名模型不受影响。
- 删除不取消正在运行的任务，不批量改写历史会话或已经落盘的模型选择。
- 被删除模型此前若是默认模型，新建选择沿用现有 `resolveInitialModelSelection` 规则回退到第一个可用模型；没有可用模型时保持无选择状态。
- `enabled: false` 仍表示保留模型但不可执行、不可选择，与删除无关。

## 状态所有者与事件顺序

- Built-in Source 继续拥有 Built-in Provider 的模型成员、访问配置和固定规则。
- Personal Provider 配置拥有用户的 `excludedModelIds`、Personal Model 成员、排序和 exact model rules。
- `ProviderConfigService` 是模型删除事务的唯一写入边界。
- 早期过滤是纯读取行为，由 resolver 和成员校验共用同一个过滤函数，不新增第二个状态所有者。

```text
用户点击删除
  → UI 提交 providerId + modelId
  → ProviderSettingsFacade 按 Provider 串行 mutation
  → ProviderConfigService 在一次 Personal Repository update 中
      写入 excludedModelIds
      若属于 Personal：同时移除成员与排序项
      无论来源：删除该复合键的 exact rule
  → 原子持久化 provider_config.json

系统解析该 Provider 的模型成员
  → 先减去 excludedModelIds
  → 再执行去重、排序、来源判定、配置解析
  → Settings View / Registry / 模型选择 全部基于过滤后的名单
```

## 配置与迁移边界

`ProviderConfig` 增加可选的 `excludedModelIds`，类型为非空字符串数组，作用域是单个 Provider 记录，不允许出现在 Built-in Source 规则里。旧配置没有该字段时按空集合处理。

早期开发版本曾把字段写为 `hiddenBuiltinModelIds`。配置解码时在解析 Personal Provider 规则之前，把该旧字段归一化为 `excludedModelIds`；写盘只写新字段。

Provider 删除会移除整条 Provider 记录，其墓碑随之消失；重新创建同名 Provider 不会继承旧墓碑。Personal Model 重命名和模型排序不修改 `excludedModelIds`。

## 失败与恢复语义

- 目标 Provider 或模型不存在时拒绝操作并保留原有状态。
- membership 或 Personal revision 过期时拒绝写入，不提交半成品。
- 上游 Built-in 配置刷新不会让已删除模型重新出现。
- 删除失败时 UI 保留权威 Settings View，不提交本地删除草稿。

## 负面边界

- 不提供恢复或撤销入口。
- 不在添加路径上增加针对墓碑的额外校验；成员解析阶段的过滤已经保证不会重名。
- 不把墓碑做成全局黑名单。
- 不物理修改 Built-in Source 的模型定义。
- 不修改 OAuth、账号权益、Provider 凭据、远程同步或 Agent 协议。
- 不把 `enabled: false` 复用为删除语义。
- 不批量重写会话、草稿、自动化和历史记录。

## 验收场景

1. Personal Provider 中存在 Personal Model 和 Built-in Model，两者都显示删除按钮，点击后都从当前 Provider 的列表消失。
2. 删除后页面不再出现任何"已隐藏"面板或提示；重启应用后被删模型仍不出现。
3. 删除 Personal Model 后，个人配置中的成员、排序和 exact rule 均被清理。
4. 两个 Provider 使用同一个模型 ID；删除 Provider A 后，Provider B 仍显示并可选择该模型。
5. 上游内置配置刷新后，被删模型不会重新出现。
6. 删除后修改 Provider 名称、Base URL 或启用开关，删除记录仍生效。
7. 被删除模型此前若是默认模型，新选择自动回退，不报错。
8. 已有旧字段的配置文件加载后，模型仍保持删除状态，磁盘上改写为新字段。

## 验证

至少覆盖 Provider 配置服务、成员解析与 Registry、Provider Settings Service 和 UI 交互层；执行目标包已有测试，以及仓库要求的 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
