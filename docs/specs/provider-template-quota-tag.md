# Spec：添加供应商模板的「已适配额度显示」Tag

## 背景与决策

「添加供应商」模板选择器（`packages/ui/src/settings/model-provider-section/ProviderTemplatePicker.tsx`）
目前所有模板卡片只有 logo + 名称 + 箭头。用户在挑供应商时无法预判一件事：**配好凭据之后，
YCode 里能不能看到自己这家账号的额度/余额**。这个能力在仓库里只对少数几家开放，却完全没有在
选择阶段暴露，用户往往要新建完、切到设置页才发现没有，属于事后才知道的负向惊喜。

本期在模板卡片标题文字后加一个小胶囊 Tag 标注这条能力：

- 文案：中文「已适配额度显示」，英文 "Quota display supported"。
- 位置：紧跟标题文字末尾（同一行内流，标题换行时跟到最后一行末尾）。
- 样式：沿用设置页既有小标签规格（`ModelInputCapabilityBadge`、模型选择器徽标同源）：
  `rounded-full border border-border bg-surface px-1 py-px text-ui-xs text-foreground-subtle`。
  `rounded-full` 在 `DESIGN.md` 的形状例外里属于「刻意胶囊形」，合规。
- Tag 是纯静态渲染：**不新增网络请求、不新增状态、不发事件**。

## 覆盖范围与判定来源

判定只有一个事实源：`@zcode/shared` 里各能力自己的模板判定函数，按 `templateId` 判定。

| 能力                               | 判定函数                                                                                                 | 展示位置                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| DeepSeek 官方账户余额              | `isDeepSeekProviderTemplateId`（`packages/shared/src/deepseek-balance.ts`，`templateId === "deepseek"`） | 设置页 provider 卡片 + 输入框 context 浮层 |
| OpenCode 套餐用量                  | `isOpenCodeProviderTemplateId`（`packages/shared/src/opencode-usage.ts`，前缀 `opencode-`）              | 同上                                       |
| 官方 Coding Plan / Start Plan 额度 | 只认账号级 provider id（`account:zai-*` / `account:bigmodel-*`）                                         | 不经过模板                                 |

即 `packages/ui/src/settings/model-provider-section/providerTemplateQuotaTag.ts` 的
`supportsTemplateQuotaDisplay` 只是把上面两个判定取并集——**不复用、不重写、不放宽**，
保证「卡片上标了」和「实际能看到」永远是同一个条件。新增 `opencode-*` 模板时因走前缀判定
自动继承，无需改本处。

**不做 baseUrl 匹配**：手动填 DeepSeek / OpenCode 地址的自定义 provider 可能走代理或第三方
网关，它的凭据在官方额度接口上大概率无效。标 Tag 反而会让用户以为「配了就能查」。

### 为什么智谱 4 张 Coding Plan 模板不加 Tag

这是刻意保留的不对称，不是漏标。

`config/provider/zcode-builtin.json` 里 `zai-api` / `bigmodel-api` 的显示名是
「Z.ai Coding Plan / BigModel Coding Plan」，但它们只是 **api-key 模板**
（`access.type === "zhipu-coding-plan-api-key"`）。从模板新建走 `createPersonalProvider`，
产出的是普通个人 provider，`providerId` 不是账号级 id；而额度链路
（`V4ComposerToolbar.tsx` 的 `resolveFamilyForPlanProviderId`）只认
`account:zai-individual-coding-plan` 等账号级 id。所以这类 provider 的设置页卡片和输入框
context 浮层里都不会出现额度或余额——挂了 Tag 就是撒谎。

同理，「创建自定义供应商」永远没有 Tag：自定义端点无法预知走的是官方接口还是中转。

### 不在范围内

- 不改模板命名与分组（`config/provider/zcode-builtin.json`）。
- 不动已配置 provider 的左侧导航、设置页余额/用量面板、输入框 context 浮层的任何逻辑。
- 不给 Kimi / MiniMax / 阿里云百炼 / openai / anthropic / xai / openrouter / xiaomi-mimo 加 Tag。

## 验收场景

1. 「添加供应商」页中，DeepSeek 与 6 张 OpenCode 卡片的标题文字后紧跟一个胶囊 Tag，文案为
   「已适配额度显示」（英文界面 "Quota display supported"）。
2. 其余所有卡片（含 4 张智谱、Kimi、MiniMax、阿里云百炼 2 张、「创建自定义供应商」）没有 Tag。
3. OpenCode 两行标题（如 `OpenCode Go (Anthropic)`）的卡片，Tag 跟在第二行文字末尾，不换行错位、
   不溢出卡片、不把卡片高度撑到与邻居不一致。
4. 卡片的点击创建、创建中 `disabled`、创建失败横幅重试行为完全不变；边框 / hover / focus-visible
   样式不变。
5. 深色、浅色主题与手机 Web 单列布局下 Tag 均不溢出、不与右侧箭头重叠。
6. Tag 不撒谎：新建 DeepSeek / OpenCode provider 后设置页卡片与输入框 context 浮层确实出现
   余额/用量；新建智谱 Coding Plan provider 后确实没有。
