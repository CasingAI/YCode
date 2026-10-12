# Spec：欢迎页 API Key 引导列出全部可显示额度的供应商

## 背景与决策

欢迎页 API Key 表单（`packages/ui/src/login/LoginApiKeyForm.tsx`）的 Provider 下拉写死了
`zai / bigmodel` 两项（类型 `ApiKeyProviderChoice = "zai" | "bigmodel"`，映射
`zai-api / bigmodel-api`）。用户在引导阶段只能二选一，而仓库里能显示额度的远不止这两家。

额度能力已有唯一事实源 `supportsTemplateQuotaDisplay()`（见
`docs/specs/provider-template-quota-tag.md`）：DeepSeek、MiniMax Token Plan、OpenRouter、
智谱四模板（`zai-api / bigmodel-api / zai-standard-api / bigmodel-standard-api`）、
OpenCode Go/Zen。引导下拉复用它的子集，不另起白名单，保证「引导里可选」和
「建完能看到额度」永远是同一个条件。

## 覆盖范围

引导下拉列出全部**单 API Key 即可建出可用供应商**的模板，共 13 个：

| templateId | 展示名（zh-CN） | 额度口径 |
| --- | --- | --- |
| zai-api | Z.ai Coding Plan | 智谱 quota/limit 自存 Key 直查 |
| bigmodel-api | BigModel Coding Plan | 同上 |
| zai-standard-api | Z.ai API | 同上（普通推理 Key 无 monitor 权限时降级提示） |
| bigmodel-standard-api | BigModel API | 同上 |
| deepseek | DeepSeek | 官方余额接口 |
| minimax-token-plan | MiniMax Token Plan | 官方套餐接口（Beta，未经真实账号验证） |
| openrouter | OpenRouter | 官方余额接口（Beta，未经真实账号验证） |
| opencode-go-chat | OpenCode Go (Chat) | Go 套餐三窗口，需在设置页另配 Cookie + Workspace（见 opencode-usage-quota.md）；建完即可推理 |
| opencode-go-messages | OpenCode Go (Anthropic) | 同上（Anthropic 接口形态） |
| opencode-go-responses | OpenCode Go (Responses) | 同上（Responses 接口形态） |
| opencode-zen-chat | OpenCode Zen (Chat) | Zen 账户余额，需在设置页另配 Cookie + Workspace；建完即可推理 |
| opencode-zen-messages | OpenCode Zen (Anthropic) | 同上（Anthropic 接口形态） |
| opencode-zen-responses | OpenCode Zen (Responses) | 同上（Responses 接口形态） |

排序：智谱四模板优先（`zai-api / bigmodel-api / zai-standard-api / bigmodel-standard-api`），
其次 DeepSeek、MiniMax Token Plan、OpenRouter，最后 OpenCode（Go 三模板在前、Zen 三模板在后，
组内按 Chat / Anthropic / Responses）。与设置页“添加供应商”选择器的
智谱优先分组同序。

默认选中：中文环境默认 `bigmodel-api`，英文环境默认 `zai-api`（沿用
`resolveLoginApiKeyDefaultProvider` 的 locale 规则）；若默认项不在可用列表中
（模板被下线），取列表第一项。

数据源：`providerSettingsView.providerTemplates` 经
`supportsTemplateQuotaDisplay(templateId) && isApiKeyAccess(config.access)` 过滤，
再按上述顺序排序。标签走 `resolveProviderTemplateName(templateId, template, locale)`，
图标走设置页同款 `ProviderLogo`（按 `template.config.logo`），「获取 API Key」外链走
所选模板的 `access.apiKeyManagementUrl`。无可用模板时禁用“继续”，复用
`login.apiKey.providerMissingError` 提示。

跳过语义：`buildLoginApiKeySkipSettings` 仅当所选模板属于 zai/bigmodel family 时才写
`providerFamilyDomain`；选 DeepSeek / MiniMax / OpenRouter 时跳过只关引导，不写域名归属
（`ProviderFamilyDomain` 类型保持 `"zai" | "bigmodel"` 不变）。

保存语义不变：`createPersonalProvider({ templateId, initialConfig: { access } })` →
`markApiKeyLoginSuccess` → `onSaved`；`templateId` 从 2 选 1 变成 13 选 1。
OpenCode 模板同样只收一个 API Key 即可建出可用供应商（推理直通 `zen/go` /
`zen` 端点）；用量三窗口/余额仍需用户事后在设置页按 opencode-usage-quota.md
绑定 Cookie + Workspace，引导页不收 Cookie、不做用量预检。

## 不在范围内

- OAuth 一键登录通道不动：`getProviders()` 为空、“没有可用的登录提供方”警告、
  `WelcomeScreen.tsx` 的等待/重试/取消流程全部保留。
- 引导页不收 OpenCode 的 Cookie + Workspace：用量查询绑定仍只在设置页
  （`opencodeUsageService` 的 `opencode-usage:<providerId>`），引导建完先能推理，
  用量卡片在配好 Cookie 前保持未配置形态。
- `minimax` 普通平台模板、Kimi、阿里云百炼、OpenAI / Anthropic / xAI、xiaomi-mimo、
  “创建自定义供应商”无额度能力，不列入引导，与设置页 Tag 口径一致。
- `providerFamilyDomain` 类型与迁移逻辑不动。

## 验收场景

1. 全新状态打开欢迎页 → 点“使用 API key” → 下拉看到 13 项，每项带对应 logo；
   中文环境默认选中 BigModel Coding Plan，与改前一致。OpenCode 六项位于末尾
   （Go 三模板在前、Zen 三模板在后）；选 OpenCode 填 Key 建完可直接推理，
   用量显示需事后去设置页绑定 Cookie + Workspace。
2. 切到 DeepSeek → 右侧“获取 API Key”打开 `https://platform.deepseek.com/api_keys`；
   填 Key 点继续 → 建出 DeepSeek personal provider，设置页卡片能查到余额。
3. MiniMax Token Plan / OpenRouter 同理可建并继续；外链分别跳各自模板配置的
   `apiKeyManagementUrl`。
4. 英文环境默认选中 Z.ai Coding Plan。
5. OAuth 为空的首屏行为不变：警告仍在，“使用 API key”仍能进新下拉；
   暂时跳过仍只关引导、不写空 Key。
6. 设置页“添加供应商”卡片 Tag 与详情余额显示不变。
