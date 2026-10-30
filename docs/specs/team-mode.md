# Spec: Team 档（裁决者档，提示词层引导）

权限轴第四档由 **Bare**（秘书白名单档）改为 **Team**（内部值 `team`，显示名 Team）。权限上 Team 与 Agent（`yolo`）完全相同：完整工具面、无额外权限门；与 Agent 的唯一差异是模型可见标签 `<mode>Team</mode>` 与配套的行为引导。差异化全部在提示词层，引导遵循一条文风约束：**简洁、授权式，不写强制规则清单，不限制模型发挥**。

本文件是 Team 档、官方 `team` 技能与内部值迁移的权威规格。三档公共权限规则仍以 [`agent-mode-axis.md`](./agent-mode-axis.md) 为准。原 Bare 秘书白名单与 Worker 可切档工人（`bare-mode.md` / `bare-worker.md`）已整体废弃，动机与拆除清单见「废弃记录」。

## 目标

- 主 Agent 是昂贵的裁决者：只负责拆解、派发、审阅子代理证据、质量裁决与汇总；调查、实现、测试、取证等执行工作由子代理完成。
- 任务小、重复失败或上下文不足都不构成主 Agent 亲自接手的理由；主 Agent 不代做执行工作。
- 提示词只做角色定位与授权，不枚举场景禁令。
- 子代理回到普通模式的双件套（Explore / general-purpose），不为 Team 维护专用内置类型。

## 产品规则

### 定位与引导

- 显示名 **Team**，内部值 **`team`**。与 Plan / Ask / Agent 并列、可互切；轮换 Plan → Ask → Agent → Team → Plan；新建默认仍是 Agent。
- Collaboration modes 段的 Team 行只有一句授权式文案，产品基调是「善用子代理，你对质量把关」：鼓励把调查与修改派给子代理，主 Agent 对结果质量负责。不写 "Do not X" 式禁令、不枚举例外场景、不写手册正文。
- 每步注入 `<mode>Team</mode>`（既有标签机制，无节流、无散落散文提醒）。
- 官方 `team` 技能（内容型插件：无 MCP、无商店 listing、默认启用）承载可按需加载的展开引导，Collaboration modes 的 Team 行只留加载指针。手册同样保持简洁，允许的内容：
  - 角色定位一句话，与 Team 行同基调。
  - 派发建议：预期要动手的任务线从 general-purpose 起手（能读能写，先查后改留在同一条会话）；纯调查用 Explore；同一条任务线优先 SendMessage 续跑已有子代理，独立、并行才新开。
  - 证据回报：子代理回报自带证据（diff、命令输出、关键引用），裁决建立在证据上。
  - 失败熔断：一次失败指调用工具报错、中断、空输出，或回报完全无可用交付（无证据、无结论、无改动）。失败按同一任务或工作切片计连续次数，跨子代理累计，换代理不清零；只有出现可用交付才清零。因上下文窗口即将用满而交接且已交付成果，不算失败。首次失败先对原代理重试一次；若创建调用尚未返回 `agentId`，则重试该创建调用一次。第二次连续失败必须换新子代理，交接目标、失败原因与已有证据，替代子代理的一次尝试计第三次。连续第三次失败才停止该任务：不进行第四次尝试，也不由主代理补做；停止时报告三次尝试的执行者、失败原因、已有成果与阻塞点。
  - 交叉复核是可选项而非默认：结论足够重要时，可再派一个子代理复核前一子的结论。
  - EnterPlanMode：引导不进 Plan，Team 档内就地拆解与设计（文本 + todo 呈现）；机制不拦。
  - Goal 自主循环里同样尽量把执行派给子代理。
- UI 中文描述一句话，与 Team 行同基调（如「善用子代理干活，主模型把关质量」），不得沿用「不亲自改工作区」类禁令式旧文案。

### 权限

- `team` 的权限判定与 `yolo` 同路径：无秘书白名单、无工具裁剪、无派出类型硬门。项目 allow / allowedTools / disallowedTools 的语义与 Agent 档完全一致。
- `isGoalRestrictedMode` 只认 plan / readonly；Team 放行（与 Agent 同）。`isRestrictedMode` 不认 team。
- JSVM / Sandbox / Bash 在 Team 下与 Agent 档同规则。

### 自动化任务中的 Team

- 定时、周期、自定义间隔、延时与闲时任务都可在创建时选择 Team；省略档位时新建默认 Agent，更新省略保留，列表保留 Team。模型入口 `CronCreate` / `CronUpdate` / `OffPeakCreate` 与 UI 同规。
- Team 自动化任务运行期间由 runtime 持有无人值守锁，模型不能自行切档；Team 档「机制不拦 EnterPlanMode」的规则在自动化执行中不适用，`EnterPlanMode` 被 runtime 硬拒绝。
- 用户手动切档仍可生效，但不会解除锁；只有之后被接受的人工新消息才解锁。锁的所有者、持久化与 fail-closed 规则见 [`automation-execution-mode.md`](./automation-execution-mode.md)。
- 子代理不新增锁：所有子代理工具面已剔除 `EnterPlanMode` / `CreatePlan`，不存在子代理自行切档入口。

### 子代理

- 内置子代理收回两项：`general-purpose` / `Explore`。Worker（SmartWorker）删除：派出场、设置页、内置覆盖表不再出现。
- 未写类型的派出默认 `general-purpose`（所有档位一致）。
- 子代理档位与权限等级门沿用 axis 规格：Explore 只读、通用全权；plan / readonly 父派全权子仍拒绝；Team 父是完全访问等级，可派任意子。
- 派出 / 续跑不再接受档位切换参数（Worker 专属能力，随 Worker 删除）；子档解析 `resolveSubagentPermissionMode` 保持现状。
- `context_remaining_percent` 回报、SendMessage 续跑、History 观测等既有基建原样保留。

## 状态所有者与事件顺序

真值仍是 runtime `AgentRuntimeConfig.mode`，写入点、事件顺序、投影链路与 axis 规格一致，不新增路径。

```text
composer 四选草稿 → 提交载荷 mode("team") → resolveExecutionState
  → applyRuntimeExecutionState → runtime.config.mode
  → PermissionContext.mode（与 yolo 同判定路径，ruleId 同 mode.yolo）
  → 每步 <mode>Team</mode> 标签
```

## 迁移

- `normalizeLegacyExecutionMode`：`bare` → `team`（裸字符串与 `{mode}` 对象两种旧格式都收）；未知值仍收敛默认档，不得收成 team。
- `submissionModeSchema` / `admissionMode` 值域换成新四档；旧事件日志里 `admissionMode: "bare"` 按既有「非白名单值丢弃该字段」规则处理，行照常下发。
- `previousMode` 等宽值域字段保留 bare 容忍旧数据。
- 历史 SmartWorker 会话与 `agents-state.json` 的 Worker 覆盖键：读取路径宽容回退（显示 fallback 到通用 Subagent），不迁移、不特判、不重建整表。

## 不变量

- Team 档不引入任何独立权限分支；判定路径与 yolo 相同。
- 模型可见引导只有三处：每步标签、Collaboration modes 一行、可选技能手册；不随回合追加散落提醒。
- 不为 Team 维护专用内置子代理类型。
- 提示词不写按场景枚举的禁令清单；唯一的显式停止条件是失败熔断（同一工作切片跨代理连续三次失败）。

## 验收

1. 新建默认 Agent；选择器四项显示 Plan / Ask / Agent / Team；轮换含 Team。
2. Team 下 Write / Bash / JSVM / 工作区 Read 全部放行（ruleId 与 Agent 档相同的 `mode.yolo`）；不存在 `mode.bare.*` / `mode.worker.*` / `mode.team.*` 拒绝码。
3. 每步注入 `<mode>Team</mode>`；Collaboration modes 段 Team 行为一句授权式文案 + 技能指针。
4. Team 下 `/goal` 提交、resume、队列消费、编辑重发均成功；Ask / Plan 仍拒。
5. Team 父派 Explore / general-purpose / 自定义均成功；plan / readonly 父派全权子仍拒绝；`SmartWorker` 不再是可派类型。
6. 旧数据：`mode:"bare"` 会话恢复为 Team；`admissionMode:"bare"` 行丢弃该字段照常下发；SmartWorker 历史会话仍可显示（fallback 通用）。
7. `team` 技能手册包含角色边界与失败处理：主 Agent 只拆解、派发、审阅证据、质量裁决与汇总，任务小、重复失败、上下文不足均不得亲自执行；首次失败先对原代理重试一次（未拿到 `agentId` 时重试创建调用一次）；第二次连续失败换新代理并交接目标、失败原因与已有证据，替代代理的一次尝试计第三次；同一工作切片跨代理连续三次失败才停止，无第四次尝试且主 Agent 不补做；有可用交付即清零，正常低上下文交接不计失败；停止时报告三次尝试的执行者、失败原因、已有成果与阻塞点。
8. 自动化任务可选 Team：定时 / 延时 / 闲时与 `CronCreate` / `CronUpdate` / `OffPeakCreate` 均可显式写 `team`，列表保留 Team；运行期模型调用 `EnterPlanMode` 被硬拒绝，人工新消息解锁后恢复可切换。
9. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过。

## 废弃记录

- **Bare 秘书白名单**（`BARE_SECRETARY_TOOL_NAMES`、`checkBareMode`、`mode.bare.secretary` / `mode.bare.nonSecretary`、权限顺序中的秘书门与「项目 allow 不能放行 Bare 下的 Write」特殊不变量）：主 Agent 被硬门绑成盲秘书，验证与取证都要派子代理，实践判定为过紧；权限差异整体搬至提示词层。
- **Worker 可切档工人**（原 `bare-worker.md` 全部：SmartWorker profile、`mode.bare.workerParentRequired` / `mode.bare.builtinReplacedByWorker` / `mode.worker.modeSwitchUnsupported` / `mode.worker.modeSwitchWhileRunning`、派出与续跑的切档参数、设置页内置第三项与「仅 Bare 可派」文案）：在「主模型昂贵、子模型廉价」的目标场景下，为省子代理缓存而维护专用类型不成立；「先查后改同一条会话」由派发建议（动手线从 general-purpose 起手）以手册形式替代。
