# 会话列表计划卡描边的冷启动持久化

## 目标

会话列表圆点上的计划卡描边跨进程重启稳定：宿主刚启动、会话尚未加载时，上一轮带有效计划卡的会话在列表里直接显示描边，不再需要点进会话后才出现。

## 背景

描边事实 `lastTurnHasPlanCard` 由 sessions-index 实时投影从会话行窗口派生（`hasPlanCardInLastAssistantResponse`），判据语义曾收窄过一次，派生能自动按新语义出结果。但冷启动种子 `loadStoredSessionSummaries` 只读 session store 元信息、不读正文，未加载会话的摘要没有该字段——表现为 Web / 桌面宿主刚启动时所有未打开会话的描边整体消失，点进会话触发实时投影覆盖后才恢复。用户预期列表装饰跨重启稳定，且描边的服务对象恰好是「还没打开的会话」。

## 产品规则

- 描边判定本身不新增路径：实时投影仍是唯一权威事实源，判据、conflation、流式门控全部沿用现状。
- 在描边事实**翻转时**把它作为提示性元数据写入 session store 的 session 行（`last_turn_has_plan_card` 列）：进程内每次成功发布建立基线后，仅值变化时写一次；存储实现用「值未变不落盘」的单语句窄写，禁止复用全字段 `updateSession`（避免并发覆盖其它元数据）。
- 写入是 UI 提示事实，不是 correctness 状态：写入失败只记 warn，不阻断摘要发布、不重试。
- 冷启动种子把持久化标志映射进 `SessionSummary.lastTurnHasPlanCard`；旧会话/未写过该列的会话视为未知（NULL），种子不带该字段，不显示描边。
- 会话加载后实时投影照常覆盖种子值（既有行为），持久化值不反向影响投影。
- 判据语义将来再演进时，允许带版本字段或后台惰性重算，本次不做。

## 状态所有者

| 状态                                 | 所有者                                        | 说明                                                     |
| ------------------------------------ | --------------------------------------------- | -------------------------------------------------------- |
| 描边事实真值                         | `ProductProjection` 行窗口 + shared 纯判据    | 既有路径，本次不改                                       |
| 持久化提示 `last_turn_has_plan_card` | session store `session` 行（0025 迁移新增列） | gateway 翻转时经宿主钩子窄写；未加载会话的冷启动种子读取 |
| 种子摘要 `lastTurnHasPlanCard`       | `loadStoredSessionSummaries`（v4-bridge）     | 直接映射持久化列，未知（NULL）不带字段                   |

## 事件顺序

1. 会话事件进入 gateway → `publishCurrentSummaryToIndex` 派生 `planRing`。
2. `planRing` 与进程内已发布基线不同（或首次发布）→ 调用宿主钩子 `persistLastTurnPlanCard`，同步窄写 session 行；失败仅 warn。
3. `ingestConversation` / `flushIndex` 照常发布 sessions-index 帧；已加载会话的描边始终以实时投影为准。
4. 宿主重启 → sessions-index 订阅时 `loadStoredSessionSummaries` 读种子，带出持久化描边 → 未加载会话的列表行直接显示圈。

## 验收场景

1. 会话以有效计划卡收口 → session 行 `last_turn_has_plan_card = 1`；随后新响应不带计划卡 → 值翻回 0。
2. 描边值未翻转的事件流不再写库（单语句无变更即无写入）。
3. 宿主重启后，未打开过、上一轮带计划卡的会话在 Web 与桌面列表直接显示描边。
4. 升级前的旧会话（列值为 NULL）不显示描边，点进后按实时投影正常显示。
5. 存储写入失败（如库只读）时列表发布不受影响，日志出现 warn。
