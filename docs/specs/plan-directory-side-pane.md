# Spec: 会话计划目录侧边栏

## 目标

让用户像浏览文件一样浏览当前会话的全部计划。`ListPlans` 仍是模型恢复上下文的只读工具；用户在聊天区看到它找到多少计划后，可以显式打开会话级计划目录，再从目录进入现有的单计划详情。

## 状态所有者与数据流

```text
会话计划目录（.zcode/plans/<sessionId>/*.md，一个文件一份计划）
  → 运行时读目录并解析 frontmatter
  → v4/conversation/plans
  → conversationProjectionStore.state.sessionPlans
  → plan-directory side-pane tab
  → 点击目录行
  → 现有 plan-detail / PlanDetailSidePane
```

- **目录条数恒等于计划文件份数，与 `CreatePlan` 被调用过几次无关**（历史 `ExitPlanMode` 行同理）。目录项就是文件，一条文件一条，没有第二条派生路径。`ListPlans` 数的是同一批文件，两个视图天然一致。
- `state.sessionPlans` 是计划目录的唯一 UI 数据源，元素是计划条目（`planId` / `planFilePath` / `title` / `overview` / `createdAt` / `toolCallId` / `markdown`），由 CLI 排好序；UI 直接渲染，不重排、不再从 transcript 行派生任何字段。
- 读目录与解析 frontmatter 是运行时的活（`workspaceRoot` 与会话计划子目录的位置是它的知识），协议层只透传条目。UI 自己不碰文件系统、不解析 frontmatter。
- `plan-directory` tab 只保存 workspace/session scope，不冻结计划列表；重新挂载时从 projection 读取最新目录。
- `ListPlans` 的模型输出和 `{ kind: "list_plans", planCount }` display 只用于工具摘要，不写入目录状态。
- 目录行用 `planId` 做 React key，用 `toolCallId` 打开现有 `PlanDetailSidePane`。历史无 frontmatter 的文件没有 `toolCallId`：仍然列出并可查看（详情页用条目自带的 `markdown` 冻结内容），但不带路径操作。

## 产品规则

- 目录身份为 `(workspaceKey, parentSessionId, remoteSessionId)`，其中 `workspaceKey = workspaceIdentity?.trim() || workspacePath`，缺失的 `remoteSessionId` 归一为空值；同一会话重复打开只聚焦已有 tab，跨会话、跨 workspace 和 remote session 隔离。
- 目录**固定按 frontmatter 的 `created` 降序**（最新在前），`planId` 只在两条计划 `created` 相同时作稳定 tiebreaker。`created` 是「最新是哪份」的唯一排序依据（写入即固定，区别于可被编辑改变的 mtime），由 `listSessionPlanFiles` 的升序结果反转得到，缺失 `created` 的历史文件排最末。排序只发生在 CLI 一处，UI 不重排，因此不存在两边给出不同顺序的可能。
- 排序规则是**常驻的界面事实**，不是可切换的控件：目录头部右侧固定放一枚 disabled 的「按时间排序」说明。刻意不给第二选项、不引入排序状态所有者——规则只有一个时，可点的控件只会诱导用户点一个不会变化的东西。禁用的按钮仍用 `title` 说明当前规则。
- 目录项展示创建时间（`M月D日 HH:mm:ss`，跨年补年份，`title` 给含年份的完整本地时间），位置在副标题下面。**刻意不用「N 天前」式相对文案**：计划常常是几周前定的，那种文案回答不了「这份是什么时候定的」；也不用「今天/昨天」，侧栏长时间开着时这类词会在用户眼皮底下过期。显示到秒是因为 frontmatter 的 `created` 有毫秒精度，两份计划完全可能落在同一分钟内——按分钟展示会让用户分不出谁新。`createdAt` 缺席时整行不渲染，不留空行。
- 目录项的副标题只能用 frontmatter 的 `overview`，缺失时不显示副标题，绝不把 `markdown` 计划正文当作摘要；标题用 frontmatter 的 `title`，缺失时走运行时已算好的正文提取回退，再缺则用计划目录标题兜底。
- 副标题完整换行展示，最多 6 行封顶（`line-clamp-6`），超长时由 `title` 属性保留全文供悬停查看。`overview` 是 `CreatePlan` 必填、模型专门写的 1-3 句短概述，单行截断会把「做什么、不做什么」这类关键信息截掉，因此不按单行处理。
- 状态面板的"会话计划"提供打开目录入口；目录行再提供进入详情的入口。
- 有活动会话时，侧边栏的"打开标签页"启动器和 `+` 菜单常驻"计划目录"入口；即使当前没有计划、模型没有调用过 `ListPlans`，用户也可以打开目录并看到诚实空态。该入口只在用户点击时 reveal 侧栏，不自动打开。
- 草稿态没有 `parentSessionId` 时不展示计划目录启动项，避免创建无 scope 的目录 tab。
- `ListPlans` 工具卡只显示本地化摘要和"查看计划目录"动作。成功计数为 0 时不提供动作；运行中、失败、拒绝和停止状态不读取旧 display。
- 目录和工具卡都不把某次工具输出当作会话目录。目录读的是计划文件，但读文件的是运行时；`ListPlans` 的输出不参与目录状态。
- 工具调用成功不会自动打开侧栏；只有用户显式点击入口才 reveal side pane，避免模型行为抢走对话焦点。
- 目录只读，不提供"执行计划"、删除、重命名或文件写入操作。

## 接口与不变量

- 目录 tab 与详情 tab 使用现有 `WorkspaceSidePaneTab` scope、可见性和切换逻辑；目录行的详情打开请求必须带当前 `parentSessionId`，`toolCallId` 存在时一并带上。
- `ListPlans` display 在 contracts、shared V4、core `createToolResultDisplay` 和 UI parser 四处保持同名判别值 `list_plans` 与 `planCount` 非负整数约束。
- `plan-directory` 与 `plan-detail` 可以并存；目录重复打开幂等，详情按 `toolCallId` 幂等。
- 目录加载失败或暂无计划时显示诚实空态，不影响聊天 transcript、压缩和计划文件连续性。单份计划文件读不出来时沿用 `ListPlans` 的逐份降级：其余条目照常列出，该条 `title` 缺席。
- 目录在计划落盘后刷新。落盘必然伴随那次 `CreatePlan` 变为终态行（历史 `ExitPlanMode` 行同理），现有失效判定（终态计划工具行的 `row.appended` / `row.upserted`）因此仍然成立。
- Desktop continuous 与 Web/手机 replayable 继续使用既有 snapshot/delta、metadata 和 scope 规则；本功能不新增队列、ACK 或远端状态。目录是只读查询，两个 profile 返回同一份文件列表。

## 负面边界

- 不把 `ListPlans.display`、模型 Markdown 或 `output.text` 保存为目录数据。
- 不修改 `CreatePlan` 写入路径（handler 内落盘）、计划文件的列目录排序规则（旧在前、新在后）、Fork 继承、压缩提示或 `ListPlansOutput` 模型契约。
- 不让 UI 自己读计划文件或解析 frontmatter：读目录是运行时的知识，协议层只透传条目。
- 不保留旧 `plans: ToolCallRow[]` 结果的兼容分支：桌面 renderer 与 CLI 同版本发布，Web server 与前端同仓构建。
- 不做跨会话或跨 workspace 的计划聚合：目录始终是会话级。
- 不把计划目录做成计划卡的展开内容，不复用"执行计划"动作。
- 不做可切换的排序控件：不引入排序状态、不落进 tab 身份（tab 仍只存 `(workspaceKey, parentSessionId)`）、不新增排序选项。
- 不改 `plan-detail` 详情面板（头部刻意不显示路径，本次也不加时间）、不改 `ListPlans` 工具卡与状态面板的计数展示。
- 不动计划卡与详情面板的数据源：它们继续从 transcript 行取正文，也继续依赖冷恢复的 `plan_file_written` 补 `planFilePath`。
- 不动另外两个目录侧栏（子代理、工作流）的头部样式，也不改 `getPlanDirectoryTitle` 的标题回退链。

## 验收场景

1. 当前会话有两份计划文件：打开目录后两项按创建时间降序，点击任一项进入对应详情。
2. **目录条数 = 计划文件份数**：模型在同一会话里多次调计划工具、但其中有的因正文为空或入参校验失败而没有落盘时，目录仍然只列出已落盘的那几份，与 `ListPlans` 说的份数逐条对得上。
3. 活动会话中打开空白侧栏：启动器和 `+` 菜单都显示"计划目录"；没有计划时也能打开并显示空态，不需要 `ListPlans`。
4. 同一会话从工具卡、状态面板和侧栏启动器重复打开目录：只有一个目录 tab，重复点击只聚焦，不新增副本。
5. 切换会话、workspace 或 remote session：目录和详情按 scope 隔离，不泄漏旧会话计划。
6. `ListPlans` 成功计数为 2：工具卡只显示计数和入口；模型仍能收到完整 `plans[]` 与 `latest.content`。
7. `ListPlans` 计数为 0、运行中、失败、拒绝或停止：分别显示稳定空态或状态文案，不展示旧摘要。
8. 重启恢复或远端 replay 后目录仍由 `state.sessionPlans` 重建；目录不依赖某次 `ListPlans` 调用。
9. 桌面宽布局和手机窄布局下目录项不横向溢出，长标题和长概述保持可读。
10. 会话里有 3 份以上创建时间分散的计划：目录从上到下按创建时间降序，每条在简介下面显示自己的创建时间（精确到秒），第一条就是最新的。
11. 同一分钟内落盘的两份计划：两条行内时间不同（秒位可区分），顺序与先后一致。
12. 点击头部那枚「按时间排序」：按钮保持 disabled、无反应、顺序不变；悬停能看到规则说明。
13. 从磁盘删掉其中一份计划文件后重开会话：目录少一条，状态面板的「会话计划」计数同步变。
14. 历史无 frontmatter 的计划文件：仍出现在目录里（标题走正文提取回退），行内不显示时间，点进去能看到正文但没有路径操作。
15. 切换语言到 English：头部说明与行内时间都走英文日期格式，无 `Invalid Date`、无未翻译 key 字面量。
16. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；相关 core、UI、side-pane 定向测试通过。
