# Spec: Bare 协作档与子代理 Ask/Agent

在 Plan / Ask / Agent 轴上增加可中途切换的第四档 **Bare**（内部值 `bare`，显示名 Bare）。父工具表与 Agent 相同，调用时只放行秘书白名单。Goal 把门从「必须 yolo」改为「只拒 plan/readonly」。子代理工作档只有 Ask / Agent；Ask/Plan 父只能派出只读权限子，完全访问子直接拒绝。

本文件是 Bare、秘书白名单、Goal 拒绝白名单、子权限等级门的权威规格。三档公共权限规则仍以 [`agent-mode-axis.md`](./agent-mode-axis.md) 为准；本文件只写第四档与子代理章对那份规格的增量。

## 目标

- 主会话四档并列、可互切；新建默认仍是 Agent。
- Bare 父不亲自做工作区活：只与用户对话、派子代理、读写待办、停/看子任务。
- 中途切档不省略工具表（保住前缀缓存），不打断已在跑的子代理。
- Goal 在 Agent 与 Bare 下放行；Plan / Ask 仍拒。
- 子不能是 Bare 或 Plan。只读父不得派出完全访问子（拒绝，不压档）。

## 状态所有者

真值仍是 runtime `AgentRuntimeConfig.mode`，经 `resolveExecutionState` 接纳。`bare` 加入 `executionPermissionModeSchema` / `CollaborationMode` / `submissionModeSchema`。`normalizeLegacyExecutionMode` **不得**把未知值收成 `bare`（未知仍是 yolo）。派生位：`planEnabled` / `readOnlyEnabled` 在 `bare` 下都为 false。`isRestrictedMode`（暂停 Goal）只认 plan/readonly，**不认** bare。

```text
composer 四选草稿 → 提交载荷 mode → resolveExecutionState
  → applyRuntimeExecutionState → runtime.config.mode
  → PermissionContext.mode（deps.getMode，不存在 service 实例上）
```

PermissionService 实例可在父子间共享；判定只读本次 `context.mode`。父 Bare 漏进子的充要条件是子 `runtime.config.mode` 仍是父档。

## 产品规则

### 主会话四档

- 选择器与 Plan / Ask / Agent 并列。显示名 **Bare**，内部值 **`bare`**。不得把内部值直译成文案。
- 工具表与 Agent 相同；调用时非秘书白名单 `deny`。
- 可中途互切。切档不杀已在跑的子。
- 新建默认 Agent（`yolo`）。轮换：**Plan → Ask → Agent → Bare → Plan**。
- Collaboration modes 段静态增加 Bare；每步只打 `<mode>Bare</mode>`。Bare 那一行只加一句指针：若技能列表有 `bare`，派活前用 Skill 加载；手册正文不进系统提示（保前缀缓存，也不污染其它档）。
- 计划卡「执行计划」仍切 `yolo`。不实现退 Plan 回到 Bare。`EnterPlanMode` 的 `previousMode` 只是记录，不是退档栈。
- 闲时/自动化仍锁死 `yolo`。任务轴不加 Bare。
- `/side` 不在本次范围。

### 秘书白名单（第三份表，禁止与另两份合并）

独立常量，含 Agent/Task 别名：`Agent`、`Task`、`SendMessage`、`TaskOutput`、`TaskStop`、`AskUserQuestion`、`TodoWrite`、`TodoRead`、`Skill`。

其余 deny，`ruleId` 为 `mode.bare.nonSecretary`，文案统一一句、不点工具名。时间线与 Ask 拒绝可观察性相同（见 `permission-denied-tool-observability.md`）。

不在白名单：MCP、Bash、Read/Write、EnterPlanMode、CreatePlan、Sandbox、工作流、定时任务等。Skill 只用于加载手册，不能绕过对其余工具的拒绝。

权限顺序：`userInteraction` → `alwaysAsk` → `yolo` 整档放行 → `disallowedTools` → 项目 deny/ask → `plan` / `readonly` → **`bare` 秘书门（项目 allow 之前）** → 项目 allow → webfetch / workflow 草稿 / `allowedTools` → `never`。项目 allow 与 `allowedTools` 不能放行 Bare 下的非秘书工具。

三份表职责不同，禁止合成一张万能只读表：

| 表 | 位置 | 用途 |
| --- | --- | --- |
| `isReadOnlyTool` | PermissionService | Ask/Plan 只读能力回退（含 Agent/Task/Skill） |
| `READ_ONLY_TOOLS` | scheduler | 调度并发（无 Agent/Task，含 Skill） |
| 秘书白名单 | PermissionService Bare 分支 | Bare 调用放行（含 SendMessage/TaskOutput/TaskStop/Skill，不含 Read） |

### Goal：拒绝白名单

拒绝：`plan`、`readonly`。放行：`yolo`、`bare`。不得把载荷改写成 yolo。`restrictedGoalMode` 只识别 plan/ask，**不要**把 bare 收进 ask。

必须同时改的门（漏一处验收就不成立）：

- `sendGoalCommand`：仅 plan/readonly 冲突；bare 放行。
- `resumeGoal`：Ask/Plan 且已有 target 才拒；Bare 有目标则放行并续跑。
- `continueGoalAfterChange`：plan **或** readonly 都不续跑（现状只看 plan，Ask 下会漏网）；yolo/bare 续跑。
- 队列消费：`planBlocked` / `readOnlyBlocked`；Bare 两档都为假。
- 编辑重发 `editGoalGateReason`：同上。
- UI 发送前：只拦 plan/readonly；Bare 不进 toast 分支。
- UI ACK：只认既有 `guard.planGoalMutuallyExclusive` / `guard.readOnlyGoalMutuallyExclusive`；Bare 放行后不应收到这两码。秘书拒绝与 Goal ACK 不得混成一句。
- `modeRestrictsGoalCommands`：等价于 plan 或 readonly。Bare 面板仍显示 `/goal`。
- `isRestrictedMode`：Bare 不是受限档；Agent↔Bare 带 active Goal 不暂停。
- 续跑文案仅 Bare 改「派子代理取证」；裁判不变。

### 子代理

工作档只有 Ask（`readonly`）或 Agent（`yolo`）。禁止 Bare、禁止 Plan。不存在 Plan 子；Plan 父的只读子就是 Ask 子。

**权限等级（与工作档分开）：**

- 只读等级：Ask / Plan 父。只能派出只读权限子。
- 完全访问等级：Agent / Bare 父。可派 Ask 或 Agent 子。

**派出拒绝，不压档。** 解析子档之后：父为 plan/readonly 且子为 yolo → 拒绝本次派出（可见，与工具拒绝同类时间线），`ruleId` 为 `mode.restricted.subagentFullAccess`，不创建子 runtime，不把子改写成 Ask 再跑。派出工具（Agent/Task）在 Ask/Plan 下仍算只读能力；等级门在解析完 `childMode` 之后。不要在权限服务里整工具禁掉派出，否则 Explore 也派不出。

解析 `resolveSubagentPermissionMode`：`auto`→yolo；旧 `plan`→yolo；`undefined`：Explore→readonly，其余→yolo；删除 `default: parentMode`。解析结果再过等级门。

- Explore：不写画像 `permissionMode`；四处特判保留（explore 工具集、独立 PermissionService、mode 解析、只读 prompt）。mode 从 yolo 收到 readonly。任意父可派出。
- 通用：运行时固定 yolo。Ask/Plan 父下派出拒绝（相对今天「继承只读并成功」是行为变更）。Agent/Bare 父下派出成功且可写。
- 设置：运行档位与可用工具可叠加。新建/旧自定义/插件 → Agent。Explore 锁 Ask、通用锁 Agent，设置里不能改。
- 继承全部 = 主会话完整执行工具面，不是父 `getTools()`。Ask 子工具表可全，写则拒。
- UI：Ask/Plan 下完全访问子不作为可执行候选；协议直连仍派出则运行时拒绝。

**回报剩余窗口：** 子 runtime 在回合结束后用与 GetContextUsage / 自动压缩同一套算术拍快照。父模型只看到尾部相关信息里多一行剩余百分比（`context_remaining_percent`），不给绝对 token、窗口大小或压缩阈值。本轮消耗行（`subagent_tokens` 等）保持原样。拍不到快照则这一行缺席，不当成 0%。Agent 初次完成、SendMessage 续跑终态、子任务通知三处同一字段名。0% 是真实「窗口已满」，只有未知才缺席。

### 模型引导（官方 `bare` 技能）

- 内容型官方插件 `bare`：无 MCP、无商店 listing、默认启用。发现列表只有一条 `bare`。受众是模型，不放进 zcode-guide。
- 系统 Prompt 只点「若列表有 `bare`，派活前用 Skill 加载」；怎么当秘书、怎么优先续跑已有子，写在技能 Index。
- Bare 仍拒 Read：章节不能按需 Read。Index 必须自包含可操作规则。`references/` 可作可选深度，但 Index 须写明 Bare 下不要等 Read。
- 复用规则：同一任务线用已有 `agentId` 走 SendMessage；只有独立、可并行或换工种才新开 Agent。读尾部剩余百分比：够用就续，将满则新开。

## 接口

- shared：`executionPermissionModeSchema`、`submissionModeSchema` 含 `bare`；`admissionMode` 在 rows 复用 submission schema；`createSession.firstInput.mode` 走 submission schema，`config.mode` 保持 `z.string()`。
- contracts：`CollaborationMode` 四值；`RUNTIME_MODE_TAGS` 含 Bare；plan-mode output 的 `mode`/`previousMode` 含 `bare`；`permission-full-access.previousMode` 加 `bare`。
- CLI：command-center Extract / 标签表 / handler；**没有** `cli/.../app-mode.ts`。TUI 轮换在 `tui/src/app-mode.ts`。
- 编译期硬点只有 `permission/service.ts` 的 `never` 与 `RUNTIME_MODE_TAGS` 的 `Record<CollaborationMode, string>`。`SWITCHABLE_MODES` / `STABLE_FORK_MODES` 是 Set，漏加是运行时静默。`ZCODE_AGENT_MODE_OPTIONS` 漏加会把 bare 收成 yolo。

## 不变量

- Bare 不省略父工具表。
- 秘书白名单不与 `isReadOnlyTool` / `READ_ONLY_TOOLS` 合并。
- Goal 拒绝白名单只含 plan/readonly；不得写成 `!== "yolo"`。
- 子工作档不得为 plan 或 bare。
- 只读父派出 yolo 子必须拒绝，禁止压档。
- `normalizeLegacyExecutionMode` 不产出 `bare`。
- `previousMode` 不构成退档栈。

## 验收

1. 新建会话默认 Agent；选择器四项；轮换 Plan→Ask→Agent→Bare→Plan。
2. Bare 拒 Read/Write/Bash/Sandbox/EnterPlanMode，`ruleId` 为 `mode.bare.nonSecretary`；放行 Agent、待办、TaskOutput/TaskStop、AskUserQuestion、Skill。项目 allow 不能放行 Bare 下的 Write。
2a. Collaboration modes 的 Bare 行含加载 `bare` 技能的指针，不含手册正文。技能列表出现 `bare`。
2b. 子代理完成/续跑/通知的尾部用量信息含 `context_remaining_percent` 一行；不含剩余 token；快照缺席时不出现该行。
3. Bare 下 `/goal` 提交、resume、队列消费、编辑重发、`continueGoalAfterChange` 均成功；Ask/Plan 仍拒（含续跑不得在 readonly 放过）。ACK 走既有两条 reasonCode，不进通用横幅。
4. Agent↔Bare 带 active Goal 不暂停；切 Ask/Plan 仍拒切或暂停按既有受限规则。
5. 每个 Bare 步注入 `<mode>Bare</mode>`；续跑文案为派子代理取证。
6. Bare 父派通用子：`getMode()===yolo` 且 Write 放行。Ask/Plan 父派通用或自定义 Agent：可见拒绝、无子 runtime。Ask/Plan 父派 Explore 或自定义 Ask：成功且写则拒。
7. Explore 任意父下按 Ask 拒写。继承全部得到非空完整执行工具面。
8. 从 Bare 调 EnterPlanMode：权限门拒绝（可观察），不要求进 Plan。若输出曾写出 `previousMode: "bare"`，schema 必须能解析。
9. 切 Ask 不杀已在跑的子。旧 `build` 不变成 Bare。
10. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过。
