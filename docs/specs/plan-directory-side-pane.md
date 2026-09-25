# Spec: 会话计划目录侧边栏

## 目标

让用户像浏览文件一样浏览当前会话的全部计划。`ListPlans` 仍是模型恢复上下文的只读工具；用户在聊天区看到它找到多少计划后，可以显式打开会话级计划目录，再从目录进入现有的单计划详情。

## 状态所有者与数据流

```text
有效 transcript 的终态 ExitPlanMode 行
  → v4/conversation/plans
  → conversationProjectionStore.state.sessionPlans
  → plan-directory side-pane tab
  → 点击目录行
  → 现有 plan-detail / PlanDetailSidePane
```

- `state.sessionPlans` 是计划目录的唯一 UI 数据源；只接受终态 `ExitPlanMode` 行，并沿用 `buildSessionPlansModel` 的标题、`overview`、正文和 `planFilePath` 规则。
- `plan-directory` tab 只保存 workspace/session scope，不冻结计划列表；重新挂载时从 projection 读取最新目录。
- `ListPlans` 的模型输出和 `{ kind: "list_plans", planCount }` display 只用于工具摘要，不写入目录状态。
- 目录行使用 `toolCallId` 打开现有 `PlanDetailSidePane`；详情正文仍来自对应 `ExitPlanMode` transcript 行。

## 产品规则

- 目录身份为 `(workspaceKey, parentSessionId, remoteSessionId)`，其中 `workspaceKey = workspaceIdentity?.trim() || workspacePath`，缺失的 `remoteSessionId` 归一为空值；同一会话重复打开只聚焦已有 tab，跨会话、跨 workspace 和 remote session 隔离。
- 目录默认按会话计划模型的最新在前展示；目录项的副标题只能使用 `ExitPlanMode` 的 `overview`，缺失时不显示副标题，绝不把 `markdown` 计划正文当作摘要；标题缺失时沿用计划目录标题回退。
- 副标题完整换行展示，最多 6 行封顶（`line-clamp-6`），超长时由 `title` 属性保留全文供悬停查看。`overview` 是 `ExitPlanMode` 必填、模型专门写的 1-3 句短概述，单行截断会把「做什么、不做什么」这类关键信息截掉，因此不按单行处理。
- 状态面板的“会话计划”提供打开目录入口；目录行再提供进入详情的入口。
- 有活动会话时，侧边栏的“打开标签页”启动器和 `+` 菜单常驻“计划目录”入口；即使当前没有计划、模型没有调用过 `ListPlans`，用户也可以打开目录并看到诚实空态。该入口只在用户点击时 reveal 侧栏，不自动打开。
- 草稿态没有 `parentSessionId` 时不展示计划目录启动项，避免创建无 scope 的目录 tab。
- `ListPlans` 工具卡只显示本地化摘要和“查看计划目录”动作。成功计数为 0 时不提供动作；运行中、失败、拒绝和停止状态不读取旧 display。
- 目录和工具卡不读取 `.zcode/plans` 文件，不解析 frontmatter，不把某次工具输出当作会话目录。
- 工具调用成功不会自动打开侧栏；只有用户显式点击入口才 reveal side pane，避免模型行为抢走对话焦点。
- 目录只读，不提供“执行计划”、删除、重命名或文件写入操作。

## 接口与不变量

- 目录 tab 与详情 tab 使用现有 `WorkspaceSidePaneTab` scope、可见性和切换逻辑；目录行的详情打开请求必须带当前 `parentSessionId` 与对应 `toolCallId`。
- `ListPlans` display 在 contracts、shared V4、core `createToolResultDisplay` 和 UI parser 四处保持同名判别值 `list_plans` 与 `planCount` 非负整数约束。
- `plan-directory` 与 `plan-detail` 可以并存；目录重复打开幂等，详情按 `toolCallId` 幂等。
- 目录加载失败或暂无计划时显示诚实空态，不影响聊天 transcript、压缩和计划文件连续性。
- Desktop continuous 与 Web/手机 replayable 继续使用既有 snapshot/delta、metadata 和 scope 规则；本功能不新增队列、ACK 或远端状态。

## 负面边界

- 不把 `ListPlans.display`、模型 Markdown 或 `output.text` 保存为目录数据。
- 不修改 `ExitPlanMode` 写入路径、计划文件排序、Fork 继承、压缩提示或 `ListPlansOutput` 模型契约。
- 不让 UI 读取计划文件或解析 frontmatter。
- 不把计划目录做成 `ExitPlanMode` 计划卡的展开内容，不复用“执行计划”动作。

## 验收场景

1. 当前会话有两份终态计划：打开目录后两项按最新在前显示，点击任一项进入对应详情。
2. 活动会话中打开空白侧栏：启动器和 `+` 菜单都显示“计划目录”；没有计划时也能打开并显示空态，不需要 `ListPlans`。
3. 同一会话从工具卡、状态面板和侧栏启动器重复打开目录：只有一个目录 tab，重复点击只聚焦，不新增副本。
4. 切换会话、workspace 或 remote session：目录和详情按 scope 隔离，不泄漏旧会话计划。
5. `ListPlans` 成功计数为 2：工具卡只显示计数和入口；模型仍能收到完整 `plans[]` 与 `latest.content`。
6. `ListPlans` 计数为 0、运行中、失败、拒绝或停止：分别显示稳定空态或状态文案，不展示旧摘要。
7. 重启恢复或远端 replay 后目录仍由 `state.sessionPlans` 重建；目录不依赖某次 `ListPlans` 调用。
8. 桌面宽布局和手机窄布局下目录项不横向溢出，长标题和长概述保持可读。
9. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；相关 core、UI、side-pane 定向测试通过。
