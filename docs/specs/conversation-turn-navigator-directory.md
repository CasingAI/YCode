# Spec: 对话问题导航目录侧信道 + 时间线按需加载（conversation turn navigator directory）

## 目标

把左侧「对话问题导航」rail 的数据源从时间线渲染窗口解耦：目录走只读侧信道
`v4/conversation/queryDirectory`（CLI 投影全量行聚合，一条实用户 query 一条），
时间线窗口只保留可视附近的行，按需取窗（`rows/range` 三方向扩展）。根治旧实现
的三类开销：全量水合（200 行/页连发至 `hasMore=false`）、1Hz 全量 hover 预览重建、
滚动写后读强制重排。落地后移除 `conversationTurnNavigatorEnabled` 实验开关。

## 产品规则

- rail 常开（`hideTurnNavigator` 仍独占分享流程），不再有实验开关。
- 目录骨架 = `origin === "realUser"` 的 `userInput`；background/goal/mailbox 等系统上下文不得入目录。
- 导航粒度 = query：同 product turn 多条 steer query 逐条建项，`key` 用稳定 row 身份（entity 延续规则与旧 renderer 一致）。
- hover 摘要已在 CLI 按 220 字 / 2 段截断；空摘要由 UI 按 kind 做本地化兜底，CLI 只传空串，不做 i18n。
- 同一 running product turn 只有最后一条 query 标 `running`。
- 时间线窗口语义：缺省尾窗；向上 `beforeRowId` 补页（现有行为：只取数进 `pendingOlder`，滚动静止后提交）；
  向下 `afterRowId` 补页（中部窗口未连尾部时）；跳转 `aroundRowId` 换窗（一次往返，目标落入窗口内）。
- 中部窗口（未连尾部）时：到达底部不自动贴住跟随新行；提供回到尾部入口（整替换回尾窗并贴底）。
- 流式 delta 仍经订阅推送进当前窗口；目录失效只触发目录重查，不拉行。

## 接口

- `packages/shared/src/zcode-protocol-v4/directory.ts`（新）：
  `v4ConversationQueryDirectoryParamsSchema`（`sessionId`/`clientMode?`/`afterRowId?`/`limit≤queryDirectoryMaxEntries`，strict；`clientMode` 由 host attachment 注入、renderer 省略，与 rows/range 同构——strict schema 必须显式收下它，否则网关 parse 抛错、目录恒空、rail 永不渲染），
  `conversationQueryDirectoryEntrySchema`（`key`/`rowId`/`turnId`/`userPreview`/`assistantPreview`/`assistantPreviewKind: text|running|empty`，strict）、
  `v4ConversationQueryDirectoryResultSchema`（`entries` 升序/`hasMore`/`atSeq`/`atRevision`/`atLogEpoch`，strict）、
  纯函数 `buildConversationQueryDirectoryEntries`（CLI/单测共用）。
- `packages/shared/src/zcode-protocol-v4/core.ts`：`PROTOCOL_V4_LIMITS.queryDirectoryMaxEntries = 500`。
- `packages/shared/src/zcode-protocol-v4/transport.ts`：
  `V4_METHODS.conversationQueryDirectory = "v4/conversation/queryDirectory"`；
  `v4ConversationRowsRangeParamsSchema` 加可选 `afterRowId`/`aroundRowId`（与 `beforeRowId` 三方向互斥由 CLI 裁决，schema 只做可选是从旧客户端偏斜安全出发）；
  `v4ConversationRowsRangeResultSchema` 加可选 `hasMoreNewer`（老结果缺省，等价尾部未知）。
- CLI：`server.ts` 加 `case V4_METHODS.conversationQueryDirectory`；
  `v4-gateway.ts#queryDirectory` 复用订阅就绪管线（readyFlights/hasLiveConversation/ensureColdReadyPublisher/hydratePublisher），profile 由 `clientMode` 决定（`desktop-continuous` → `continuous`，否则 `replayable`，与 rows/range 同语义），
  `rowsRange` 加方向互斥校验（>1 抛 `fault.rowsRange.conflictingCursor`）；
  `conversation-topic-publisher.ts#getQueryDirectory`（按 turn 聚合 `turnHeader` state 判 running，无 header 页首中段按非 running）与三方向 `getRowsRange`
  （around 按 `findIndex` 切半窗，目标缺失返空由调用方按纪元作废；after 取 `slice(0, limit)`）。
- services：`zcodeAgent.ts` 加 `ZCodeAgentConversationQueryDirectoryParams` + 接口 `conversationQueryDirectoryV4`，
  `rowsRange` params 加 `afterRowId?`/`aroundRowId?`；`zcodeAgentService.ts` 实现透传（trusted 校验 + `V4_METHODS.conversationQueryDirectory`），
  `zcodeAgentConnectionScope.ts` facade 转发。
- UI transport：`transport.ts` 接口加 `queryDirectory`；`agentConversationTransport.ts` 实现；
  `replaceableConversationTransport.ts` 加转发（接口新增成员必须同步长出转发，workflowRunEvents 漏接教训）；
  `workspaceConnectionRegistry.ts` 窄面加 `conversationQueryDirectoryV4`。
- store（`conversationProjectionStore.ts`）：state 加 `queryDirectory`/`queryDirectoryRevision`/`queryDirectoryLoading`/`queryDirectoryError`/`windowEpoch`
  （`useConversationProjection.ts` CLOSED_STATE 同步）；`refreshQueryDirectory()` 按 revision+logEpoch 双校验分页取（500/页，游标未推进即停）；
  `loadWindowAround(rowId)`/`loadNewer()`/`loadTailWindow()` 整替换窗口并递增 `windowEpoch`，`pendingOlder` 换窗时作废；
  `contiguousToTail`（或等价命名）标记中部窗口是否连尾部，delta/换窗时维护。
- Timeline（`ConversationTimeline.tsx`）：props 加 `turnNavigatorDirectory`/`queryDirectoryLoading`/`windowEpoch`/`canLoadNewer`/`onLoadNewer`/`onLoadTailWindow`/`onJumpToDirectoryEntry`；
  rail 改传 `items`（`buildConversationTurnNavigatorItems(turnNavigatorDirectory)`，running 叠加用窗口实时集合覆盖），
  `turnNavigatorQueryRowIds` 改由目录派生；`turnNavigatorVirtualItems` 携带 `turnId`（active 按 turn 容器挂目录项）；
  `scrollToQuery` 接受 `{ rowId, turnId, unitIndex? }`（分享面板旧下标兼容）；`windowEpoch` 变化复位 prepend 块与滚动记忆；
  底边触发向下补页，回到尾部入口整替换并贴底；删除宽度 observer 与全量水合 hydration effect（含 attempt/retry state）。
- SessionPane：下发目录/epoch/canLoadNewer 等 props；`queryDirectoryRevision` 驱动 `refreshQueryDirectory()`；
  rail 点击先换窗（`loadWindowAround`）再 rAF 按 `rowId` 精确落点；`hideTurnNavigator` 保留。
- rail（`ConversationTurnNavigator.tsx`/`conversationTurnNavigatorHelpers.ts`）：props `renderUnits`→`items`，
  `onJumpToQuery(target: { rowId; turnId })`；`VirtualItem` 加 `turnId?`；active 返 `turnId`（按 `firstIndexByTurnId` 映射）；
  删除旧 `normalize/truncate/buildAssistantPreview`（预览构建收归 CLI 纯函数）。
- 分享导出（`conversationTurnNavigatorTypes.ts` 新）：`buildConversationShareNavigatorEntries(units)` 本地骨架——
  导出选择必须与已载入窗口同源，且 CLI 目录条目没有 productTurnId 归属；目录侧信道只服务 rail。
- 开关移除：删除 `validationAppSettings`（schema+patch）、`protocol.ts`、`SettingsPage`（读值+写回 handler）、
  `ExperimentalFeaturesSection`（turnNavigator 行；dynamicWorkflow 行保留）、`useSettingService` 广播条件、
  `SessionPane`/`Timeline` 的 `turnNavigatorEnabled` 门控与 props、`hideTurnNavigator` 保留、i18n
  （`settings.conversationTurnNavigator*`、`chat.turnNavigator.*` 保留 rail 自身文案）、
  `conversationTurnNavigatorGate.test.ts`（开关门控测试；替换为目录纯函数/换窗测试）。旧 `setting.json` 残留键不报错（zod 默认忽略未知键）。

## 状态与时序

```
订阅帧（snapshot/deltas）
  └─▶ store.applyFrame
        ├─ snapshot 整换 → queryDirectoryRevision+1、windowEpoch+1（pendingOlder 作废）
        └─ deltas 命中 realUser userInput/row.removed → queryDirectoryRevision+1
  └─▶ SessionPane effect（queryDirectoryRevision）→ store.refreshQueryDirectory()
        └─▶ query/directory 分页（afterRowId/500）→ generation+atLogEpoch 校验 → queryDirectory

rail 点击目录项
  └─▶ store.loadWindowAround(rowId)（around 一次往返，windowEpoch+1）
        └─▶ Timeline 复位 prepend 块/滚动记忆 → rAF 按 rowId 精确落点

中部窗口滚动到底边
  └─▶ store.loadNewer()（afterRowId 向下补页，连尾部后恢复跟随）
回到最新
  └─▶ store.loadTailWindow()（缺省方向尾窗，windowEpoch+1 并贴底）
```

- 唯一所有者：CLI 投影拥有全量行；store 拥有 `queryDirectory`/`windowEpoch`/`contiguousToTail`；
  Timeline 拥有滚动/虚拟化/块；SessionPane 只转发。
- 事件顺序：目录失效 revision 递增 → 重查；换窗 epoch 递增 → 复位；delta 先进窗口，目录随后重查（不阻塞渲染）。
- 幂等边界：所有 query 只读、无状态、超时重发安全；游标未推进即停；纪元不匹配整体丢弃。
- 视觉边界：「回到最新」与「滚动到底部」共用 Timeline 内的同一个悬浮圆钮组件（composer dock 与
  无 dock 两个定位分支都必须走它），文案只进 `aria-label`/`title`、不进渲染体；两入口三目互斥，
  语义靠图标（换窗用 ArrowDownToLine、贴底用 ArrowDown）与 `aria-label` 区分。不得再内联出
  带可见文字的药丸变体。

## 验收场景

1. 2000 轮长会话打开：目录一次分页往返（500/页）即完整，不再连发 rowsRange 至 `hasMore=false`；renderer 常驻行数保持尾窗量级。
2. rail 刻度数量、活动项放大、hover 预览（220 字/2 段截断、running 仅末条）与旧实现一致；实用户 query 增删后目录刷新。
3. 中部跳转：点击未加载轮次的 rail 项，一次 around 往返后精确定位到该 query 行（扣顶栏 56px 语义不变）。
4. 向下补页：中部窗口滚到底边自动 `loadNewer`，连尾部后恢复跟随；回到最新入口整替换回尾窗并贴底。
5. 运行期 delta（assistant 流式、tool、reasoning）不触发目录重查；realUser query 增删与 rewind 触发重查且旧分支条目不回写。
6. 开关移除：设置页无 turnNavigator 行；旧 `setting.json` 残留键不报错；分享选择面板与 reopen 按钮行为不变。
7. 双窗口/手机远控：目录与窗口各自独立，无跨 pane 串号（rowId 跨会话可重复，测高/目录按会话隔离）。
8. 分享导出选择仍与已载入窗口同源，不走侧信道。
9. rewind 交错：around/after 取数期间换纪元，整批作废不拼接。

## 验证

- `pnpm typecheck`（0 error）。
- `pnpm lint`（0 error；本次改动文件无新增 warning——退役的 hydration/observer/import 残留已清）。
- `pnpm architecture:check --changed`（0 违规）。
- `node --import tsx --test packages/shared/test/conversationQueryDirectory.test.ts`（目录纯函数 6 用例）。
- 新增/改写：store 换窗三方法 + 目录刷新双校验测试、rowsRange 三方向切片测试、rail 目录 active 映射测试。
