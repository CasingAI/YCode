# Spec: 定时任务（Cron）模型工具门与实验特性 opt-in

## 目标

降低首轮模型请求的工具 Schema 占用。Cron 四件套（CronCreate/CronList/CronUpdate/CronDelete）默认不进入 provider 工具面；用户在设置「实验特性」中显式开启后，新会话才注册。实测 CronCreate（约 6K 字符）+ CronUpdate（约 3.8K 字符）合计约 2.4K tokens，是当前真实会话工具开销（约 10.7K tokens）的约 23%。

## 产品规则

- `AppSettings.automationEnabled` 是 Desktop/Web/Server/Host 的用户 opt-in 唯一事实源，缺省为 `false`；旧设置缺少字段时也按关闭处理。
- Desktop/Web/Server/Host 不读取其它配置来源、构建档位或进程环境来改变新会话的 Cron 模型工具注册。Host 只按收到的用户设置同步 policy。
- `automationEnabled` 为 `true` 时，Host 显式同步 `true`；为 `false` 时显式同步 `false`。新会话和冷恢复会话把该 policy 写入 session config，Runtime 仅在 session config 明确为 `true` 时注册 Cron 模型工具。
- 设置切换只影响之后新建或冷恢复的 session 的模型工具面。普通 session 仍然照常创建；active session 不热卸载工具；已创建的定时任务继续按原计划执行，不被暂停或删除。
- `automationEnabled` 是 Cron 模型工具注册的唯一来源。它不改变 Runtime 能力端口（AutomationPort）的存在性，也不把“模型工具未注册”转换成 disabled 拒绝。
- 关闭时 AI 无法创建/管理/查看定时任务（含 CronList）；用户需要管理时打开开关并新建会话即可。UI 文案必须明示这一点。
- 直接 TUI/headless CLI 是独立入口：默认不注册 Cron 工具（`includeAutomation !== true` 即跳过）；只有宿主显式注入 automationPort 才开启。
- UI 的 Cron 开关位于「实验特性」，与 Dynamic Workflow 开关相邻。Root 在把 AppSettings 同步到 Host 后，才把用户设置投影为 availability。
- UI 文案只说明用户设置和默认关闭，不承诺 token 数值。

## 状态所有者与事件顺序

```text
AppSettings.automationEnabled（持久化唯一事实源）
  → Root 读取并调用 Host syncAppRuntimePreferences(true|false)
  → Host 同步 workspace/updateAutomationPolicy（显式 true/false）
  → session create/resume 固定 session config.automationEnabled
  → Runtime 按 session config 决定是否注入 automationPort（includeAutomation）
  → registerBuiltInTools 按 includeAutomation 注册或省略 Cron 四工具
  → Root 在 Host 同步完成后发布 userOptIn → availability
  → UI 消费 availability；AutomationPort 能力仍独立存在
```

1. `settingService` 持久化用户设置，并让 `Root` 在设置变化后把最新布尔值交给 `zcodeAgentService`。
2. `zcodeAgentService` 持有最新用户设置，按 workspace 串行同步 policy；关闭时也发送 `false`，避免旧 CLI 保留 `true`。
3. Desktop/Web/Server/Host 的 session create、resume 和 V4 createSession 都从 Host policy 生成 session config；Runtime 在创建时固定模型工具快照。
4. active session 不动态增删工具。已创建的定时任务由 automation 调度侧独立执行，不依赖模型工具面。
5. Root 只有在 Host policy 同步 settled 后才更新 availability。availability 是 AppSettings 的 renderer 投影，不维护第二份事实。

## 接口与实现边界

- `packages/shared/src/validationAppSettings.ts` 定义 `automationEnabled`；full schema 默认 `false`，patch 接受可选 boolean。
- `packages/shared/src/app-runtime-preferences.ts`、`packages/services/src/zcode-agent/zcodeAgent.ts` 与设置同步链只传递用户 opt-in；广播使用既有 app runtime preferences 通道。
- `packages/services/src/zcode-agent/zcodeAgentService.ts` 的 Cron 会话门只读取最新用户设置；`resolveAutomationGate` 同步返回设置是否为 `true`。
- `apps/zcode-cli/packages/core/src/tool/handlers/index.ts` 的 Cron 门（`includeAutomation !== true` 即跳过）保持不变；该门只决定模型工具面。
- V4 相关 handler 与 Core 对应入口不读取 `automationEnabled`；automation 调度执行不受影响。
- 不删除 Cron 实现、AutomationPort、权限基础设施或历史定时任务。

## 验收场景

1. 默认（从未打开）：新会话 `getTools()` 无 CronCreate/CronList/CronUpdate/CronDelete，首轮工具字符减少约 9.8K（约 2.4K tokens）。
2. 打开开关后新建会话：四工具恢复可见；关闭开关后新建会话再次消失。
3. 已有关闭前创建的定时任务：关闭开关后仍按原计划执行；AI 在关闭期间无法通过 CronList 查看。
4. `pnpm typecheck`、`pnpm lint` 通过；`pnpm architecture:check --changed` 通过。
5. 中英文案完整，开关有 test-id。

## 闲时创建入口隐藏规则（不可用就不渲染）

- 灰度未命中（`grayConfig.enabled !== true`，含 `null` 未加载）或远端工作区：闲时 tab、闲时模板、闲时创建按钮一律不渲染。存量闲时任务仍展示并可管理。
- 灰度命中但创建被拦（套餐不符 `plan` / 取号失败 `quota` / 依赖不可用 `unavailable`，即 `resolveOffPeakCreateBlockReason(...) !== null`）：同样不渲染闲时创建按钮，不再展示灰色 disabled 按钮；存量任务保留。
- 副标题空态文案按闲时可见性切换：闲时完全不可见时只提定时任务，不提闲时算力。
