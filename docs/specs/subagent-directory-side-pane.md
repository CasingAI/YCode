# Spec: 子智能体目录侧边栏（启动器与 `+` 菜单入口补齐）

## 背景与目标

子智能体目录面板本身早已存在并可用：`subagent-directory` tab 类型、
`openSubagentDirectorySidePane`（幂等打开）、`SubagentDirectorySidePane`
面板、运行态/已结束态数据源、tab 图标与标题、i18n 文案全部就绪。
状态面板的子智能体分区里也有通往目录的「已结束」页脚行入口。

缺的只有一处接线：桌面侧边面板的「打开标签页」空态启动器和右上角
`+` 新增标签菜单里没有「子智能体目录」入口。用户在空白侧栏时找不到
这个已存在的能力，只能先等子智能体出现、再从状态面板点进去。
本次是补齐既有能力的接线工作，不是新功能：不新增面板、不改数据通道、
不改协议、不新增文案 key。

模板与深度标准参照 `docs/specs/plan-directory-side-pane.md`（计划目录）。
计划目录 / 子智能体目录 / 工作流目录三者并存是既定设计
（`plan-directory-side-pane.md` 第 62 行已明确「不动另外两个目录侧栏
（子代理、工作流）的头部样式」）。

## 状态所有者与数据流

```text
CLI V4 projection snapshot.subagents（running / endedTotal / revision，唯一权威）
  → SubagentDirectorySidePane 经 useConversationProjection 读取 running 实时态
  → useSessionSubagents（session/subagents 分页查询，已结束历史态，revision 变化时刷新）
  → subagent-directory side-pane tab（只读目录）
  → 点击目录行
  → 现有 subagent-session tab（buildSubagentDirectoryOpenRequest 补齐身份）
```

- 运行态来自快照 `projection.snapshot.subagents.running`，由
  `SubagentDirectoryContents` 经 `useConversationProjection(lease)` 读取；
  `lease` 按 `tab.parentSessionId` 获取，面板挂载即订阅该会话。
- 已结束态来自 `useSessionSubagents` 分页 hook（`PAGE_SIZE = 20`，
  「再显示 20 个」递增加载），`refreshKey` 取 `subagents.revision`，
  快照 revision 变化时刷新；`enabled` 要求 `projection.snapshot !== null`。
- `subagent-directory` tab 只保存 workspace/session scope
 （`workspaceKey` / `workspacePath` / `workspaceIdentity?` /
  `remoteSessionId?` / `rootSessionId` / `parentSessionId`），不冻结目录数据；
  重新挂载时从 projection 与分页查询读取最新目录。
- 目录只读，不提供启动、停止、删除子智能体的操作；行内按钮只做打开详情。
- 运行态为空且已结束数为 0 时显示诚实空态（`runningEmpty`），这是面板内部状态，
  与启动器入口是否展示无关。

## 产品规则

- 目录身份为 `(workspaceKey, rootSessionId, parentSessionId)`，其中
  `workspaceKey = workspaceIdentity?.trim() || workspacePath`，
  tab id 为 `subagent-directory:<workspaceKey>:<rootSessionId>:<parentSessionId>`
 （各段经 `encodeSidePaneTabIdPart` 编码）；同一三元组重复打开只聚焦已有 tab，
  跨 workspace、跨 root 会话、跨 parent 会话隔离。
- 有活动会话（`activeTaskId` 非空）时，侧边栏的「打开标签页」启动器和 `+` 菜单
  常驻「子智能体目录」入口；即使当前没有子智能体（运行数为 0、已结束数为 0），
  用户也可以打开目录并看到诚实空态。该入口只在用户点击时 reveal 侧栏，不自动打开。
- 草稿态（`activeTaskId` 为 null）没有 `parentSessionId` 时不展示该启动项，
  避免创建无 scope 的目录 tab。门控函数为新增的 `shouldOfferSubagentDirectory`，
  口径与 `shouldOfferPlanDirectory` 完全一致：`Boolean(activeTaskId)`。
  刻意不对「有无子智能体」做门控，理由有三：
  1. 启动器是低基数固定入口，由 `activeTaskId` 这一稳定值驱动；若按子智能体
     数量显隐，入口会在运行时来回增删，用户刚记住位置就消失；
  2. 空态本身就是诚实状态（`runningEmpty`），打开空目录不是错误操作；
  3. 与计划目录的处理保持一致（无计划时入口仍在），三个目录侧栏行为统一。
- 该入口的 label 复用 `subagentDirectory.title`（中文「子智能体目录」，
  与目录面板头部 `h2` 同一 key），图标用 `ListTreeIcon`，与
  `SidePaneTabTrigger.tsx` 里 `subagent-directory` 分支的图标保持一致
  （目录类 tab 共用同一枚「目录」图标：`plan-directory` /
  `workflow-directory` 亦然）。
- office 模式下该入口**保留展示**，与计划目录的处理保持一致
  （组装处的 office 过滤只排除 `terminal` 与 `review`，不排除目录类入口）。
  目录是只读查询面，不涉及终端/代码评审那类 office 模式需要屏蔽的能力。
- 从入口打开后，tab 标题走 `getSidePaneTabTitle` 的 `subagent-directory` 分支
  （`sidePane.subagentDirectory`），图标走 `SidePaneTabIcon` 的同分支，
  与从状态面板页脚行打开的 tab 完全一致。
- 目录身份回退口径：主 pane 从不接收非自身的 `rootSessionId`
  （`WorkbenchPane`、`V4ChatPane`、`SelectionSideChatPane`、
  `WorkflowActorSessionSidePane` 均不传该 prop），`rootSessionId` 经层层
  `?? sessionId / parentSessionId` 回退后恒等于当前会话；因此同一会话从状态面板
  页脚行和侧栏启动器重复打开目录，只聚焦同一个 tab，不新增副本。唯一传非自身
  root 的是侧栏子智能体会话 pane（`SubagentSessionSidePane.tsx:45`），它没有接
  目录打开回调（其状态面板的目录入口因缺回调而不渲染），这条链路走不到。
- fork 会话 F 与原会话 P 的目录关系：两者是 parent 不同的两个独立 tab，
  各自查各自会话的消息（`listSessionSubagents` 读被查会话自身的 messages）；
  内容重叠是因为 fork 把 Agent tool part 原文复制了过去（`clonePartForFork`
  只换 `callID`、不改 output 里的 `childSessionId`），即同一批子智能体记录被
  两个会话各引用一次，不是两份数据。侧栏另按 owner 过滤
  （`getVisibleSidePaneTabs` 内 `tab.rootSessionId === ownerTaskId`，
  `workspaceSidePane.ts:1233` 附近），切到哪个会话只看到哪个的目录，
  不会并排同现。

## 接口与不变量

- 启动器模型：`OpenTabLauncherItemId` 新增 `"subagent-directory"`；
  `resolveOpenTabLauncherItemIds` 新增可选入参 `canOpenSubagentDirectory`，
  为真时在 `plan-directory` 之后、`terminal` 之前 push（顺序与 `+` 菜单一致）；
  新增 `shouldOfferSubagentDirectory({ activeTaskId })`，签名与
  `shouldOfferPlanDirectory` 同形。
- `AnimatedSidePanePanel` 新增 props `onOpenSubagentDirectory: () => void`
  （无参，与 `onOpenPlanDirectory` 同形；scope 补齐下沉到壳层回调，不在面板层拼接）。
- 壳层新增 `handleOpenSubagentDirectoryFromSidePane`（`WorkspaceShellLayout`），
  写法照抄 `handleOpenPlanDirectoryFromSidePane`：`activeTaskId` 为空时直接返回，
  否则调 `handleOpenSubagentDirectory({ workspacePath, workspaceIdentity?,
  remoteSessionId?, parentSessionId: activeTaskId })`；`rootSessionId` 缺席，
  由 `useAppPanels` 回退为 `parentSessionId`。
  透传链：`App.tsx` 已有 `handleOpenSubagentDirectory`（`useAppPanels`，request 式）
  → `WorkspaceShellLayout` props → `handleOpenSubagentDirectoryFromSidePane`
  （无参）→ `AnimatedSidePanePanel` 的 `onOpenSubagentDirectory`。
  `AnimatedSidePanePanel` 在 `WorkspaceShellLayout` 里只有 `renderSidePanePanel`
  内的一处挂载点，改这一处即可；注意传给主会话列 `SessionPane` 的 props 区里
  还有另一套 request 式 `onOpenSubagentDirectory`（供状态面板页脚行用），不要混淆。
- 目录 tab 与详情 tab 使用现有 `WorkspaceSidePaneTab` scope、可见性和切换逻辑；
  目录行的详情打开请求必须带当前 `parentSessionId` 与 `rootSessionId`
 （`buildSubagentDirectoryOpenRequest` 已处理，本次不动）。
- `subagent-directory` 与 `subagent-session` 可以并存；目录重复打开幂等
  （`openSubagentDirectorySidePane` 按 tab id 查找复用）。
- 目录加载失败或暂无子智能体时显示诚实空态，不影响聊天 transcript 与会话连续性。
- Desktop continuous 与 Web/手机 replayable 继续使用既有 snapshot/delta、
  metadata 和 scope 规则；本功能不新增队列、ACK 或远端状态。
  目录的运行态走既有快照通道，已结束态走既有 `session/subagents` 分页查询，
  两个 profile 返回各自通道的同一份数据。

## 负面边界（不做什么）

- 不改数据通道：不动 `useConversationProjection` 的 lease/snapshot 读取，
  不动 `useSessionSubagents` 的分页、合并与刷新逻辑。
- 不改协议：不动 `session/subagents` 查询、不动 snapshot 的 `subagents` 字段。
- 不做新面板：不动 `SubagentDirectorySidePane` 的布局、头部样式、行渲染、
  分页按钮与空态文案；不动 `SidePaneTabTrigger` 的图标/标题分支；
  不动 `sidePaneTabPresentation` 的搜索/总览映射。
- 不新增 i18n key：入口 label 与面板头共用 `subagentDirectory.title`，
  tab 标题沿用 `sidePane.subagentDirectory`。
- 不新增状态所有者或第二条写入路径：打开走现有
  `openSubagentDirectorySidePane` → `commitOpenedSidePaneState`，
  UI 不直接调平台 API，workspace 身份 key 统一为
  `workspaceIdentity?.trim() || workspacePath`。
- 不动状态面板的子智能体分区与「已结束」页脚行（那是另一条已存在的入口，
  门控 `endedSubagentCount > 0` 保持不变）。
- 不动另外两个目录侧栏（计划、工作流）的头部样式与入口行为。
- 不把启动器入口按「有无子智能体」显隐（见产品规则第 3 条理由）。

## 验收场景

1. 活动会话中打开空白侧栏：启动器和 `+` 菜单都显示「子智能体目录」，
   位置在「计划目录」之后、「终端」之前；没有子智能体时也能打开并显示空态，
   不需要先有运行中的子智能体。
2. 草稿态（无活动会话）：启动器和 `+` 菜单都不显示「子智能体目录」，
   与「计划目录」行为一致。
3. 同一会话从状态面板页脚行和侧栏启动器重复打开目录：只有一个目录 tab，
   重复点击只聚焦，不新增副本（主 pane 的 `rootSessionId` 恒回退为自身会话，
   两条入口算出同一 tab id）。
   fork 会话与原会话的目录是 parent 不同的两个独立 tab：切到哪个会话，
   侧栏只显示哪个的目录，不会并排同现；两者内容重叠是因为引用了同一批
   子智能体记录。
4. 从入口打开后 tab 标题为「子智能体目录」（中/英文随语言切换），
   图标为目录图标（`ListTreeIcon`），与从状态面板打开的 tab 一致；
   切换语言到 English 无未翻译 key 字面量。
5. 切换会话、workspace 或 remote session：目录按 scope 隔离，不泄漏旧会话数据。
6. office 模式：启动器与 `+` 菜单仍显示「子智能体目录」，
   而「终端」与「审查」被过滤；与计划目录的处理一致。
7. 目录内点击一行：打开对应的子智能体详情 tab（`subagent-session`），
   目录与详情可并存；详情按 `childSessionId` 区分。
8. 运行中有新的子智能体 spawn：已打开的目录运行态随快照 revision 更新，
   已结束数变化时分页按 revision 刷新；不需要重进目录。
9. 重启恢复或远端 replay 后目录仍由 scope + 快照/分页查询重建，
   不依赖某次打开动作。
10. 桌面宽布局和手机窄布局下启动器卡片不横向溢出，长标题截断可读。
11. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；
    启动器模型单测通过。
