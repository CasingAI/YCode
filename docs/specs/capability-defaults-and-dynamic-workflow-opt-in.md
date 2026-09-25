# Spec: 重型能力默认关闭与 Dynamic Workflow 用户 opt-in

## 目标

降低首轮模型请求的工具 Schema 占用，并让用户明确控制 Dynamic Workflow。Browser Use 与 Computer Use 默认不进入 provider 工具面；Desktop、Web、Server 和 Host 的 Dynamic Workflow 新会话模型工具注册只由 `AppSettings.dynamicWorkflowEnabled` 控制。

## 产品规则

- Browser Use 默认关闭。官方插件定义与 Settings 默认集合必须保持一致；用户或项目已显式配置 `enabledPlugins[browser-use@zcode-plugins-official] = true` 时仍可开启。
- Computer Use 保持默认关闭。输入框中的 Computer Use 入口继续沿用已有默认隐藏语义。
- `node-repl-host` 仍可被默认发现，但自身不贡献 provider-visible 工具。Browser Use 或 Computer Use 任一显式开启时才注册共享 `node_repl` MCP；两者都关闭时不注册 `mcp__node_repl__js`。
- `AppSettings.dynamicWorkflowEnabled` 是 Desktop/Web/Server/Host 的用户 opt-in 唯一事实源，缺省为 `false`；旧设置缺少字段时也按关闭处理。
- Desktop/Web/Server/Host 不读取其它配置来源、构建档位或进程环境来改变新会话模型工具注册。Host 只按收到的用户设置同步 policy。
- `AppSettings.dynamicWorkflowEnabled` 为 `true` 时，Host 显式同步 `true`；为 `false` 时显式同步 `false`。新会话和冷恢复会话把该 policy 写入 session config，Runtime 仅在 session config 明确为 `true` 时注册 Workflow 模型工具。
- 设置切换只影响之后新建或冷恢复的 session 的模型工具面。普通 session 仍然照常创建；active session 不热卸载工具，正在运行的 workflow 不被强制停止；历史 run 仍可只读查看。
- `dynamicWorkflowEnabled` 是模型工具注册的唯一来源。它不改变 Runtime 能力端口、协议 `start`/`resume`/`amend` 的可用性，也不把“模型工具未注册”转换成 disabled 拒绝。
- `start`、`resume`、`amend` 继续以 Dynamic Workflow 能力端口是否存在为边界：端口/方法缺失时返回 capability unsupported；端口存在时按原有业务规则处理。关闭设置不会让普通 session 创建失败，也不会额外拒绝这些操作。
- 直接 TUI/headless CLI 是独立入口：默认不注册 Workflow 工具；只有显式合法的 `ZCODE_DYNAMIC_WORKFLOW_MODE=onDemand` 或 `alwaysOn` 才开启。该环境变量不由 Desktop/Web/Server/Host 读取、转发或覆盖。
- UI 的 Dynamic Workflow 开关位于「实验功能」。Root 在把 AppSettings 同步到 Host 后，才把用户设置投影为 availability；消费方只读 availability store，不通过 Agent service 查询有效快照。
- UI 文案只说明用户设置和默认关闭。

## 状态所有者与事件顺序

```text
AppSettings.dynamicWorkflowEnabled（持久化唯一事实源）
  → Root 读取并调用 Host syncAppRuntimePreferences(true|false)
  → Host 同步 workspace/updateDynamicWorkflowPolicy（显式 true/false）
  → session create/resume 固定 session config.dynamicWorkflowEnabled
  → Runtime 按 session config 注册或省略 Dynamic Workflow 模型工具
  → Root 在 Host 同步完成后发布 userOptIn → availability
  → UI 消费 availability；Workflow 能力端口仍独立提供 start/resume/amend/读面
```

1. `settingService` 持久化用户设置，并让 `Root` 在设置变化后把最新布尔值交给 `zcodeAgentService`。
2. `zcodeAgentService` 持有最新用户设置，按 workspace 串行同步 policy；关闭时也发送 `false`，避免旧 CLI 保留 `true`。
3. Desktop/Web/Server/Host 的 session create、resume 和 V4 createSession 都从 Host policy 生成 session config；Runtime 在创建时固定模型工具快照。
4. active session 不动态增删工具。能力端口是否存在仍由 journal/adapter 能力决定，不由模型工具快照派生。
5. Root 只有在 Host policy 同步 settled 后才更新 availability。availability 是 AppSettings 的 renderer 投影，不维护第二份事实。

## 接口与实现边界

- `packages/shared/src/validationAppSettings.ts` 与 `packages/shared/src/protocol.ts` 保留并定义 `dynamicWorkflowEnabled`；full schema 默认 `false`，patch 接受可选 boolean。
- `packages/ui/src/settings/ExperimentalFeaturesSection.tsx`、`packages/ui/src/SettingsPage.tsx` 保留 Dynamic Workflow 开关；沿用 `useSettings().update` 和 `runSettingsActionAsync`。
- `packages/shared/src/app-runtime-preferences.ts`、`packages/services/src/zcode-agent/zcodeAgent.ts` 与设置同步链只传递用户 opt-in；广播使用既有 app runtime preferences 通道并重新读取持久化设置。
- `packages/services/src/zcode-agent/zcodeAgentService.ts` 的 Dynamic Workflow 会话门只读取最新用户设置；UI 不通过 Agent service 查询额外快照，`resolveDynamicWorkflowGate` 同步返回设置是否为 `true`。
- `packages/ui/src/store/dynamicWorkflowAvailabilityStore.ts` 只以 Root 提供的 `userOptIn` 生成 `enabled`，不导入 Agent service，也不保留额外桥接或刷新缓存。
- `apps/zcode-cli/packages/cli/src/dynamic-workflow.ts` 独立解析 `ZCODE_DYNAMIC_WORKFLOW_MODE`；直接 CLI 的缺省或非法值为关闭。该模块不依赖其它配置模块。
- `apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts` 只有 `resolveRuntimeDynamicWorkflowToolsIncluded(config) === true` 才注册 Workflow 工具；该门只决定模型工具面。
- V4 start/resume/amend handler 与 Core 对应入口不读取 `dynamicWorkflowEnabled`；能力端口缺失才返回 capability unsupported，active run 继续完成，历史读取接口不受影响。
- 官方插件定义、shared 默认集合、README 同步反映 Browser Use 默认关闭；不删除 Browser/Computer 实现、node-repl host、权限基础设施或历史 workflow。

## 验收场景

1. 全新配置启动 Desktop/Web：Browser Use 与 Computer Use 均不在官方默认集合，新建 Agent session 不含 `mcp__node_repl__js`；显式开启任一能力后共享 node-repl 正常注册。
2. 全新配置启动 Desktop/Web/CLI：Workflow 设置默认关闭，普通 session 仍成功创建；新 session 不含 `CreateWorkflow`、`AmendWorkflow`、`SaveWorkflow` 等 Workflow 模型工具，但已有能力端口仍可处理 start/resume/amend。
3. 用户开启 Workflow：Root 先把 `true` 同步到 Host，之后新建或冷恢复 session 获得 Workflow 工具；Desktop/Web/Server/Host 不因其它配置或构建档位改变该结果。
4. 用户关闭 Workflow：Root 显式同步 `false`，新 session 无模型工具；active session 不热改写，直接发送 start/resume/amend 不因工具面关闭而得到 disabled，active run 不被停止。
5. 独立 CLI 不设置 `ZCODE_DYNAMIC_WORKFLOW_MODE` 时不注册 Workflow 工具；设置为 `onDemand` 或 `alwaysOn` 时按本地显式配置注册；其它值不改变默认行为。
6. active session 不因设置切换被热改写；重启或冷恢复按最新设置解释。
7. 旧 `setting.json`、旧用户显式插件配置和跨窗口广播保持兼容。
8. 定向测试、`pnpm --dir apps/zcode-cli typecheck`、`pnpm typecheck`、`pnpm lint` 与 `pnpm architecture:check --changed` 均执行并报告真实结果；本次文件执行格式检查，不做全仓格式化。

## 负面边界

- 不增加其它配置来源、缓存、强制刷新入口或 Desktop/Server 环境白名单。
- 不热卸载 active session 的工具，不停止 active run，不删除已保存 workflow 或历史 run。
- 不把 node-repl host 的可发现性误当成 provider 工具启用。
- 不通过 `allowedTools` 绕过父 session 的模型工具注册门；该门不派生能力端口或 start/resume/amend 拒绝。
- 不修改工作流语言、调度引擎、模型选择、权限基础设施或与本任务无关的本地改动。
