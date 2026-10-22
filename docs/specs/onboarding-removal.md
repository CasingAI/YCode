# Spec：引导下线（删掉设置里的「引导」）

## 背景与决策

首启策略已经是「无登录墙、无首启向导」（见 `startup-first-run-experience.md`），
但那次改造只关掉了自动触发，把「引导」这套界面原样留着：

- 设置页侧栏底部有一个「引导」按钮（火箭图标），点开是整屏覆盖的职业 / 界面模式 /
  偏好向导；
- 设置页「通用」分区有一行「引导」，按钮是「打开引导」，指向上面同一个向导；
- 还有一个 `CmdOrCtrl+Shift+O` 的隐藏快捷键可以再次调出这个向导；
- 向导背后挂着 `onboarding-record` 本地记录通道，用来留档「这个用户选过什么」，
  好在下次手动打开时预填。

这套东西现在没有实际用处：它问的是「你的主要工作方向是？」这类问卷题，答案落到
`onboardingOccupation` 之后全仓无人读取；界面模式有「更多」菜单和设置页，偏好有设置页
开关。首启不弹、菜单里有、问卷内容不产生下游行为，留着的唯一成本是每次升级都要
维护一整套问卷组件、文案和一条本地记录通道。

本次把它整块删掉。删除范围是「职业 / 偏好引导」这一整套，包括它的入口、组件、
记录通道和快捷键。

## 删除范围

| 被删对象                                | 位置                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| 职业 / 界面模式 / 偏好向导（全屏覆盖）  | `packages/ui/src/onboarding/OccupationOnboarding.tsx` 及其组件  |
| 设置页侧栏「引导」按钮                  | `packages/ui/src/settings/SettingsSectionNav.tsx`              |
| 设置页「通用」分区「引导」行            | `packages/ui/src/settingsPageHelpers.tsx`                      |
| 打开引导的快捷键                        | `packages/shared/src/shortcutCommands.ts` 的 `openOnboarding`  |
| 引导记录（本地 JSON + RPC 通道）        | `packages/shared/src/onboardingRecord.ts`、`packages/services/src/onboarding/**` |
| 引导记录的 UI 读写                      | `packages/ui/src/hooks/useOnboardingRecordService.ts` 及三处偏好反写 |
| 迁移向导里的首启欢迎页视图              | `packages/ui/src/onboarding/OnboardingWelcomeView.tsx`、`OnboardingWelcomeAsciiVisual.tsx` |

向导的问卷文案（`occupationOnboarding.*`）、设置页引导文案（`settings.onboarding*`）、
快捷键文案一并清理。

## 保留能力

- **迁移向导保留**。`OnboardingDialog` 负责从 Claude Code、Codex 等外部工具导入会话、
  Skills、MCP、命令与 AGENTS.md，这是实打实的数据导入能力，与问卷向导无关。
  它的入口从「引导」改挂到设置页「通用」分区的「数据迁移」行。
- **迁移向导里的首启欢迎页一并删除**。那一页原本是问卷向导的封面（介绍「引导」是什么、
  让用户选职业），问卷下线后它只剩装饰作用。向导打开即进入迁移步骤，
  `OnboardingDialog` 不再维护 `view` 状态，只保留向导步骤。
- **欢迎页保留**。`WelcomeScreen`（OAuth 登录 + API Key 配置）不是引导，是账号入口。
- **`onboardingOccupation` 字段保留**。存量用户本地 settings 里已经有这个值，删除会
  变成一次无谓的数据迁移；它保留为只写不读的遗留字段，不再有写入方。
- **服务侧 `settingsSyncService` 保留**。它仍是 Host 暴露的能力，UI 只是不再有引导页
  这一个调用方。

## 状态所有者与事件顺序

本次不引入新状态，只删除状态。

- 「界面模式」的所有者不变：`packages/ui/src/store/index.ts` 的 `interfaceMode`
  （localStorage 持久化），「更多」菜单与设置页照旧读写。
- 「工作区记忆」「主动任务推荐」的所有者不变：`AppSettings.memoryEnabled` 与
  `AppSettings.proactiveSuggestionsEnabled`。原本这两处还会把值反写进引导记录，
  现在只写 settings 本身——settings 一直是事实源，记录只是镜像。
- 迁移向导的开关仍由 `packages/ui/src/store/index.ts` 的 `onboardingDialogRequested`
  持有，入口只负责置位。

```text
设置页「通用」→ 数据迁移 → 打开迁移向导
  → store.onboardingDialogRequested = true
  → OnboardingDialog 收到请求 → settingsSync.actions.reopen()
  → settingsSyncService.detect() → 展示可导入项 → 用户选择 → 导入
```

## 失败语义

- 引导记录相关的一切失败语义随通道一起消失：不再有 `onboarding-record.json` 的读、
  写、超时与认领逻辑，也不再有「记录写失败但引导已保存」这类分支。
- 偏好开关的失败语义不变：`ProactiveSuggestionsSetting` 与工作区记忆开关仍然是
  先写 settings、写失败弹 toast。
- 迁移向导的失败语义不变：detect 失败仍在向导内展示错误。

## 迁移边界

- 不清洗存量数据：本地 `onboarding-record.json` 与 settings 里的 `onboardingOccupation`
  留在磁盘上不再被读取，也没有删除动作；下次用户手动清理目录时自然消失。
- 不改 OAuth / 登录 / 供应商配置链路。
- 不改 `WelcomeScreen`、`useOAuth` 与凭据存储。

## 验收场景

1. 设置页侧栏底部没有「引导」按钮，「通用」分区没有「引导」行。
2. 「通用」分区有「数据迁移」行，点「打开迁移向导」弹出迁移向导，直接进入迁移步骤
   （没有欢迎页），可正常 detect 与导入。
3. 全局没有职业问卷界面：不再出现「你的主要工作方向是？」这类页面，快捷键
   `CmdOrCtrl+Shift+O` 不再打开任何东西。
4. 「更多」菜单仍可切界面模式；设置页仍可开关工作区记忆与主动任务推荐，且重启后
   保持上次选择。
5. 账号相关行为不变：未登录时可用命令面板的「连接 / 登录」连账号，已登录时菜单里
   有「断开连接」。
6. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
