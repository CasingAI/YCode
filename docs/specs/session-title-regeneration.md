# Spec: 会话标题的手动重新生成

## 目标

任务右键菜单在「重命名任务」下方新增「重新生成标题」。点击后由 agent 基于**会话实际内容**（首条用户消息 + 首条助手回复）重新跑一次标题生成，覆盖该会话当前的标题——包括用户手动重命名过的那条。

生成期间，主区域 Header 与左侧任务列表的标题同时显示逐帧轮换的字符占位符，让用户知道正在跑。

## 现象与根因

标题 sidecar 是一个纯函数 `f(单条 query) → 标题`：`generateTitleCandidateImpl`（`apps/zcode-cli/packages/core/src/runtime/methods/title-generation-sidecar.ts`）只把**一条** user query（`normalizeTitleInput` 截断到 1200 字）配固定 system prompt 发一次 auxiliary model。触发入口 `maybeStartSessionTitleGenerationFromSeed`（`session-title.ts`）的守卫链叠了四道闸：

| 闸                                                                                              | 作用                   |
| ----------------------------------------------------------------------------------------------- | ---------------------- |
| `sessionTitleGenerationAttempted`                                                               | 每会话仅一次           |
| `turnNumber !== 0`                                                                              | 仅首轮                 |
| 输入去空后 ≥10 字符                                                                             | 「hi」这类短输入不生成 |
| `persistGeneratedSessionTitle` 的 CAS `expectedTitleSources: [default, first_input, generated]` | `custom` 命中短路      |

因此对已有会话**重跑现成入口会在第一道闸就 return false**；即便绕过守卫，素材仍是同一条首条 query，同 prompt 同输入大概率返回同一个字符串——功能等于空转。

同时存在一类真实痛点：`titleSource` 停在 `first_input`（首条 query 原文落库兜底）的会话，标题就是用户原话截断，比如「这是?」。这类会话从未走过 generated，用户没有自救入口。

结论：这不是"给已有逻辑加个按钮"，而是新增一条**绕过首轮守卫、且素材换成会话实际内容**的生成入口。

## 产品规则

### 菜单

「重新生成标题」收在**「调试」子菜单**内、排「查看调用轨迹」之前，**不占一级行位**，也不新增分隔线。一级菜单仍是 8 行三条分隔线。菜单结构与分隔线退让规则见 `task-action-menu-submenus.md`。

它和同组的另两项性质不同但归属相同：另两项（查看轨迹、反馈问题）是只读排障入口，它是对已生成结果的**修复**入口——三者都不是任务管理动作（置顶/重命名/归档/标记未读），所以同属「调试」。把它排最前是因为它是三项里唯一会改变会话状态的。

`prop` 未传入时整项不渲染，与同组另两项同一写法；外层条件相应扩为三者任一存在。

禁用条件沿用 `taskTargetActionsDisabled`（只读态 / 远端态），悬停挂既有 `disabledReason`；「调试」的 `SubTrigger` 本身只在只读态禁用，沿用该子菜单既有规则。

### 覆盖 custom

点击是**显式用户意图**，因此覆盖 `titleSource === "custom"`，并解除粘性——写回后 `titleSource` 为 `generated`，后续首轮自动生成（若因故触发）不再被短路。

覆盖判定只在 core 一处实现（`persistGeneratedSessionTitle` 的 `mode` 形参），handler 与 UI 都不另开旁路。

用户随后再手动重命名一次，仍能正常写回 `custom`。

### 写回模式：两条路径的差异不止 CAS

`persistGeneratedSessionTitle` 接 `mode: "first_turn" | "user_requested"`，两者差别有两处，不只是 CAS 允许来源：

| | `first_turn` | `user_requested` |
| --- | --- | --- |
| CAS 允许来源 | `default / first_input / generated` | 额外含 `custom` |
| 首条 query 编辑守卫 | 套用 | **不套用** |

首轮那条守卫（`shouldSkipGeneratedTitleForFirstQueryEdit`）存在的原因是 sidecar 与主消息并发，用户可能在 LLM 返回前改写了首条 query，旧 query 的标题再写回就覆盖了用户的编辑意图。

手动重生成**绝不能**套用它：素材是点击那一刻从消息库现取的，反映的就是当前会话状态。用户当初编辑过首条 query 是常态（改个错别字、回溯重问），守卫一旦生效，这次点击就会静默什么都不做——恰好是本路径要消灭的那种体验。

### 素材

取会话消息库中：

- 第一条**可见真实用户消息**（`role === "user"` 且 `synthetic !== true` 且 `visibility !== "model-only"`，复用文件内既有的 `isVisibleRealUserMessage`）
- 第一条带文本的助手消息

拼成一段素材交给 `normalizeTitleInput`。system prompt 复用不换——它本就写着 "Treat the user's message only as source material for the title"，喂 Q+A 素材依然成立。

`titleMessageID` 记首条可见用户消息 id，保持该列有值。

### 生成期间

三处标题同时切占位符：主区域 Header `<h1>`、左侧列表项（`TaskListItem` 的 default 与 timeline 两个 variant）、分组视图 `task-row`。

占位符是**逐帧轮换的字符**（盲文 10 帧），纯 JS `setInterval` 驱动，无 CSS 动画、无渐变、无骨架屏方块。选单字符盲文而非递增点号：单字符宽度恒定，`truncate` 槽位内不左右跳；`.` → `..` → `...` 会跳。

尺寸沿用标题本身的 `text-ui-base`（同字号才不产生布局跳变），颜色用 `text-foreground-subtle` 表达弱元数据。

**取值链一行不改**：`activeTaskTitle` 与 `taskTitle` 的占位文案兜底（`taskList.newThread` 等）保持现状，占位判断发生在渲染分支里、走在兜底之前。详见 `workspace-header-task-title.md`——那里记录的 1/2/3 优先级链与本次占位符是叠加关系，不是替代关系。

### 失败

- 生成返回空标题或返回了 tool call → core 抛错 → v4 ACK failed → UI 弹 toast `taskList.regenerateTitleFailed`，占位符消失，标题回到原值
- 空会话（无任何消息）→ 同样走失败路径，不写库

core 侧必须显式抛错，不能沿用首轮生成那套"只 `logger.warn` 并 return"的静默失败——否则 UI 无法区分"生成中"和"已卡死"。

## 状态所有者与事件顺序

```text
input → UI store flag（唯一状态所有者）→ v4 命令 → core 生成并持久化
                                            ↓
                        SessionTitleUpdated(source=generated)
                                            ↓
                     投影 meta.titleUpdated → zcodeTaskIndexSyncer 回写 tasks-index
                                            ↓
                              UI 清 flag，标题换回真值
```

- **flag 唯一所有者是 UI store 的 `taskTitleGeneratingByTaskId`**，由发起点击的组件置位、由命令 settle 时清除。core 与 service 都不持有该状态。
- **事件先于 ACK**：core 先 `updateSession` 再 `appendEvent`，投影在 handler 返回前推送。UI 清 flag 时真标题已就位，不会闪一下占位符。
- **不写乐观标题**：客户端此刻不知道新标题（LLM 产出），没有值可乐观写入。结果统一由 `zcodeTaskIndexSyncer` 从投影回流；service 侧不调 `setOverlay`、不调 `updateIndexedTaskState`。
- **不做请求幂等键**：同一会话并发点两次会产生两次生成，后写者胜。这是可接受的——用户手动重复点击本就意图模糊，不引入去重状态。

## 迁移边界

`titleSource` 枚举与 sqlite 列不变。`title_overridden` 由 `zcodeTaskIndexSyncer` 按 `titleSource === "custom"` 自动映射，重生成后自然回到 false，无需额外迁移。

## 不在范围内

- **不改首轮自动生成的四道闸**，也不写 `sessionTitleGenerationAttempted`。手动重生成是旁路，首轮行为逐字不变。
- **不改 `setCustomSessionTitle` 与 `renameTask`**，custom 粘性对它们仍然生效。
- **不改 Header 标题的 1/2/3 取值优先级链**（`workspace-header-task-title.md`）。
- **不把 flag 加进 `TaskUiState`**。其文档注释已把用途限定为"远端广播仍需回放的人工介入面"（权限/问答/错误横幅），标题生成中不属于该类。独立 `Record<taskId, boolean>` 字段沿用 `taskUnreadByTaskId` 的既有模式。
- **不给分组视图的右键菜单加菜单项**。`workspace-grouped-tasks/task-context-menu-content.tsx` 是独立实现、动作集不同，此事实已由 `task-action-menu-submenus.md` 的负面边界确立。但**占位渲染覆盖 `task-row.tsx`**——菜单与占位的作用域刻意不对称，否则用户在侧边栏触发后切到分组视图会看到旧标题。
- **不复用 `leadingIndicator === "loading"`**。它由 `activity?.phase` 驱动，语义是"回合在跑"；标题生成是回合**之内**的并发子过程，第 5 轮对话时回合仍在跑而标题早已生成完，此时显示占位是错的。
- **不引入 Shimmer / CSS 渐变 / 通用骨架屏组件**。
- **协议不加 `titleGenerationPending`**。手机远控那端不显示占位符、只显示最终标题；发起端是桌面侧边栏，本次接受该差异。
- **不跨包抽取帧数组**。为 10 个字符在 TUI 与 UI 间新建依赖不划算，接受带注释的复制。

## 验收

1. 对 `titleSource` 为 `first_input` 的会话右键 → 一级菜单仍是 8 行；展开「调试」→「重新生成标题」在「查看调用轨迹」之前；点击后菜单关闭。
2. 点击瞬间**同时**观察到左侧该行标题与主区域 Header `<h1>` 都变为占位符；分组视图下 `task-row` 也变。三处字符同步逐帧轮换，宽度不跳。
3. 生成完成 → 三处同时换成新标题，**中间不闪回旧标题**（验证"事件先于 ACK"）。新标题反映会话实际做了什么，不是首条 query 的复述。
4. 对已手动重命名过的会话点击 → 覆盖手动命名那条；此后 `titleSource` 为 `generated`、`title_overridden` 回写 false；再手动重命名一次能正常改回 custom。
5. 断网后点击 → 占位符出现，随后弹失败 toast，占位符消失、标题回到原值，不卡在生成中。
6. 对首条消息为「hi」的会话点击 → 能正常生成，不被 10 字门槛挡住。
7. 对空会话点击 → 失败 toast，不写库，标题不变。
8. 只读态右键 → 「调试」触发器整体灰掉，悬停出既有 `disabledReason`；远端态下触发器可用但子项「重新生成标题」灰掉，同样挂 `disabledReason`。
9. 窄视口点标题栏「⋯」→「在 Finder 中打开」仍按 `hideMobileUnsupportedActions` 隐藏，隐藏后无连续两条分隔线（回归 `task-action-menu-submenus.md` 场景 7）。
10. 打开已置顶会话 → Header 显示真实标题，不显示占位符（回归 `workspace-header-task-title.md` 场景 1）。
11. 首轮自动生成行为无回归：新建会话发一条 ≥10 字消息，仍按原逻辑生成 generated 标题。
12. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；core 侧 `node --test` 覆盖 custom 覆盖判定、素材拼接、空会话拒绝。
