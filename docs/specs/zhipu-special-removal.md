# Spec：智谱特殊功能剥离（与三方 Provider 拉平）

## 背景与决策

开源版本不应维护智谱账号体系特殊逻辑（6 个 `account:*` 内置项、OAuth 登录、编程套餐权益、Team/Start Plan、额度重置弹窗、OffPeak、私有网关直连）。
智谱只保留预制模板（Endpoint + 模型列表），与其他三方 Provider 一致：可添加、可删除、可重命名。
额度显示改为模板自建 Provider 用自存 Coding Plan Key 直查 `quota/limit`，不再依赖 OAuth 与 `accountAccess`。

## 状态所有者与接口

- 唯一所有者：`ProviderConfigService`（`packages/provider/src/config-service.ts`）的双层模型不变，
  只是 builtin 层不再包含 `account:*` 条目；personal 层是唯一的存在性写入路径。
- 模板事实源：`config/provider/zcode-builtin.json` 的 `templateRules` 保留
  `zai-api / zai-standard-api / bigmodel-api / bigmodel-standard-api` 四张模板，
  删除 8 条 `providerRules`（6 个 coding/team/start + 2 个 offpeak）。
- 额度查询：`bigmodelUsageQuotaProvider.resolveAuthorization` 新增 personal Key 直查分支，
  所有者仍是 usage-stats 服务；UI 只读快照，不自建请求。

## 行为

1. 设置页无“智谱”特殊分组、无内置 Z.ai/BigModel/Start Plan 项；模板新建的智谱 Provider
   进“自定义”分组（或保留模板分组展示），可删除，删除后不复活。
2. 模板自建智谱 Provider 填 Coding Plan Key 后显示剩余额度（level/limits/remaining/nextResetTime）；
   普通推理 Key（无 monitor 权限）额度区降级提示，不阻断聊天。
3. 不再出现：套餐权益卡、Team 定价、企业产品、Start Plan 余额提醒、额度重置弹窗/彩带、
   composer 套餐浮层、OAuth zai/bigmodel 登录入口。

## 不变量

- 远端下发机制（bundled/active/remote 三层、revision 语义、轮询）不变，只删条目。
- 其余 5 家模板额度 service（deepseek/openrouter/minimax/opencode）行为不变。
- OAuth 框架保留，只删 zai/bigmodel adapter 与 family 路由。
- 聊天、模型选择、遥测脱敏的主路径语义不变。

## 失败语义与迁移

- quota/limit 返回非成功 envelope（无 monitor 权限、Key 无效、网络失败）：额度区显示降级提示，
  不抛错、不阻断 provider 保存与聊天。
- 存量用户 personal overlay 中若残留 `account:*` 引用：读取时视为缺失（按“未配置”展示），
  不自动复活 builtin 定义；`writableProviderOverlay` 对无继承的已删 id 保持抛错语义。
- 同 revision 远端仍下发 account:* 条目时：本地解析层丢弃未知内置 id（白名单外），不断整个 release。

## 负面边界

- 不动 DeepSeek/OpenRouter/MiniMax/OpenCode 额度 service。
- 不动远端轮询、revision、control 文件合并逻辑。
- OffPeak 与官方网关直连随 Coding Plan 一起删，不单独保留（后续如需恢复另开 spec）。
