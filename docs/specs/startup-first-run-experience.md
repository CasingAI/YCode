# Spec：启动与首启体验（无登录墙、无首启向导）

## 背景与决策

产品决策：应用启动（含首次安装后首次打开）不再展示任何拦截式流程——
启动登录页（WelcomeScreen 门禁）、职业/模式偏好引导（OccupationOnboarding）、
配置迁移向导（OnboardingDialog 首启自动检测）都跳过。用户直接进入主界面，
一切按默认配置运行（interfaceMode=coding、memoryEnabled=false、
proactiveSuggestionsEnabled 关闭、occupation 不落盘）。

实现方式是「跳过」而非「删除」：登录、引导、迁移的全部代码与手动入口保持原样，
仅关闭启动路径的自动触发，随时可以单点恢复。

## 行为（启动事件顺序）

```text
启动 → RootStartupLoading（仅等待本地数据就绪，不等登录）
     → OAuth 本地缓存恢复（后台）
     → provider 数据就绪（域迁移 + 模型选择水合）
     → workspace 恢复 / 兜底默认 workspace → 主界面
```

改动点（共 4 处）：

1. `lib/rootStartupGate.ts`：`shouldEnableProviderAvailabilityLoginEntryGuard()`
   返回 `false`，provider 可用性登录门禁整体停用；改回 `true` 即恢复原行为。
2. `Root.tsx`：`welcomeScreenOpenReason` 初始为 `null`，不再消费 JWT 失效重启标记；
   `WelcomeScreenOpenReason` 仅剩运行时/手动来源（manual-login、provider-request、
   logout-provider-required、session-expired）。
3. `onboarding/OccupationOnboarding.tsx`：不再调用 `useOnboardingTrigger` 做记录判定，
   恒按「无需引导」渲染 children；引导仅由 store `newUserOnboardingOpen`
   （设置页「引导」、快捷键）手动打开。
4. `hooks/useSettingsSync.ts`：首启不再自动 `loadDiscovery()` 弹迁移向导，
   仅把 firstRunPromptHandled 标记为已处理；向导保留设置页手动打开路径。

`canRestoreWorkspaceSession` 仅由数据就绪状态决定（OAuth 恢复完成 + provider
水合完成），与登录态解耦。

## 不变量

1. 任何启动路径不得因「未登录 / 无 provider」阻塞或改写首屏内容。
2. WelcomeScreen 保持可跳过（skip）；只由运行时/手动来源打开。
3. OccupationOnboarding 挂载在主界面外层仅作为手动向导容器，不得阻塞 children 渲染。
4. 首启检测读取失败时保持向导关闭，仅记录日志，不得反过来弹窗。

## 失败语义

- 运行时 JWT 失效广播：保留既有「确认并重启」弹窗；确认重启后启动不再消费标记、
  直达主界面，取消则打开可跳过的登录页（session-expired）。
- 启动时缓存凭证失效（仅影响「曾登录且凭证被吊销」的存量用户）：
  既有弹窗 + 登录页行为保留，属运行时错误恢复，不是首启流程。
- OccupationOnboarding：自动判定已停用；手动引导的保存/留档语义不变。
- 引导记录（onboarding-record）仅用于手动打开时的预填与留档，不再驱动自动触发。

## 迁移边界

- 不删除任何文件、不清理 i18n；`useOnboardingTrigger.ts`、
  `useProviderAvailabilityLoginEntryGuard.ts`、`zcodeJwtInvalidRestartMarker.ts`
  暂无启动侧调用方，代码保留以便恢复或后续清理（knip 会如实上报）。
- 存量数据（AppSettings 的 onboarding 字段、onboarding-record.json、
  firstRunPromptHandled、localStorage 重启标记）不做清洗，仅不再驱动自动流程；
  残留标记不再被消费，无副作用。

## 验收场景

1. 首次安装启动：直入主界面（默认 workspace），无登录页、无职业引导、无迁移弹窗。
2. 未登录直接发起会话：进入主界面；模型调用失败按既有错误路径提示，
   可从设置页登录或配置 API Key。
3. 已登录用户 token 失效并确认重启：重启后直达主界面。
4. 运行中 JWT 失效且取消重启：打开登录页，可跳过；重新登录后恢复正常。
5. 设置页手动打开「引导/迁移」：仍可用，保存后偏好照常落盘。
