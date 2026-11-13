# Spec: 对话时间线滚动漂移临时运行时探针

> 本文主体是退役前的历史观测契约，只用于解释用户保留的既有日志；它不是当前生产
> 保证。当前生产不再产生逐事件探针，保留的聚合诊断见下文「探针退役」。

## 目标

为长历史对话中的滚动漂移、偏移和闪现提供可关联的运行时证据，区分以下假设：

- **H1 测高累积**：未挂载行使用估算高度，新行异步测高后改变 virtualizer 的前缀坐标。
- **H2 prepend 双阶段补偿**：历史前插先由时间线补偿，随后 virtualizer 对真实尺寸再次补偿。
- **H3 following 竞争**：用户已离开底部时，内容变化或 live-tail 变化仍触发贴底或状态重算。
- **H4 恢复/宽度重排**：会话恢复、内容宽度变化和异步测高使临时位置被浏览器 clamp 后再次写入。

本 spec 只规定诊断观测，不规定修复方案，也不改变滚动、锚定、测高或会话状态语义。

## 探针退役

> 状态：临时探针已退出生产热路径。历史日志由用户保留，现有聚合性能诊断继续生效。
> 替代验证由隔离单测与生产态浏览器用例完成，不再向应用日志追加逐事件探针。

- 已移除 `ConversationTimeline` 中所有 `recordConversationTimelineDebugEvent` 调用，以及
  只为这些调用存在的几何读取、`requestId`、TTL 上下文和 flush / cleanup timer。
- `conversationTimelineDebug.ts` 退役前只承担转发，不拥有业务状态；已核实导出引用并
  删除，测试中的模块 mock 已同步移除。
- 删除探针不得改变前插补偿、pending restore、inset 结算、用户滚动锚定与合成 scroll
  通知；真正的恢复、贴底、用户锚定和业务决策所需的 `scrollTop` 读取保留。
- `ConversationTimeline` 的 `measureRendererPerformance("conversation.turn-frame", ...)`
  与 `[ui-perf]` 聚合诊断保留；不新增长期追踪开关。
- 已写入应用的诊断日志不删除、不改写；分析结论与量化证据引用原始日志而非重新埋点。
- 不再以 `post-fix` 探针批次验证修复；修复收益按
  `conversation-update-cost.md` 的分项与组合对照方法测量。

## 历史观测契约（退役前，仅用于解释既有日志）

以下链路、事件名与字段只描述退役前的历史实现，用于阅读用户保留的日志；不是当前
生产行为，也不再要求实现保留这些探针。

- 复用项目已有的 `renderer → IPC → main logger` 链路，renderer 通过 UI logger 发出结构化诊断事件，main 进程写入应用日志文件。
- 应用日志按日期写入 `~/.zcode/v2/logs/YYYY-MM-DD.log`（测试环境沿用既有日志目录配置），应用重启后无需保留任何调试终端或外部服务。
- renderer 侧先以 50ms 窗口批量转发事件，批量内仍为每条事件保留 `sequence`；单批达到 128 条时立即 flush，避免诊断写入反过来阻塞滚动。
- 无 Desktop bridge 的 Web 环境不会产生文件日志；日志写入失败不能影响 UI。
- 不记录消息正文、用户输入、凭据或完整消息标识；只记录数量、内部索引、尺寸、偏移、状态和事件顺序。

## 历史事件与顺序（退役前）

以下事件仅存在于退役前的历史日志中；当前生产不再产生这些逐事件探针。

每个事件带 `probeId`、单调递增的本地序号；main logger 负责补充时间戳、PID 和来源。事件顺序应能还原同一次交互中的因果链：

1. `A1-measure`：virtualizer 测量行，记录测高前后的高度、索引和当前视口位置。
2. `A2-size-adjust`：TanStack 询问尺寸变化是否补偿，记录 item 范围、`scrollTop`、following、用户滚动保护/锚点状态和判定结果。
3. `A3-prepend`：历史前插 commit，记录前插基线、候选稳定 key 是否存在、`prependCaptureScrollTop`、`prependLatestUserScrollTop`、`prependUserScrollDelta`、`prependAdjustmentSource`、用户测高锚点的 reanchored/cleared 分支、最终调整量和写入前后位置。
4. `A4-content-anchor`：内容高度变化后的 layout effect，记录 following 重算结果、宽度变化状态、用户锚点聚合校正和最终动作。
5. `A5-scroll`：`scroll` 事件，记录来源、用户意图、是否实际更新 pending prepend 用户基线、following、视口和离底距离。
6. `P1-scroll-pending`：pending 期间的 scroll 事件，记录 `runId`、`requestId`、来源、用户信号、滚动前后的坐标、是否更新用户基线和 following。
7. `P2-load-start`：`loadOlder` 触发点，记录捕获的 scrollTop、锚点是否存在、预取阈值、请求状态和 requestId。
8. `P3-prepend-before-write`：prepend commit 写入前，记录新旧首行、总高度、锚点 measurement、捕获/最新用户位置、净位移、候选 adjustment 和 owner 状态。
9. `P4-prepend-after-write`：prepend 写入及 owner 交接后，记录实际 adjustment、最终 scrollTop、keyed/fallback 来源以及用户锚点重锚/清理分支。
10. `P5-user-anchor-write`：用户测高校正真正写入 `scrollTop` 时始终记录其前后的坐标、计算 adjustment、pending 标记状态，以及是否存在并关联最近的 P4；P5 不消费 P4 上下文，避免紧随其后的 P6 失去 requestId 关联，上下文按短 TTL 惰性清理。
11. `P6-programmatic-scroll`：pending 期间发生 query/unit/restore/virtualizer 程序化定位时，记录调用来源和 guard 状态，用于确认程序化位移没有进入用户基线；P4 后的短期 virtualizer 二次写入也使用最近一次 P4 的 requestId 关联。
12. `A8-top-inset`：顶部占位块出现或消失（无 prepend 同批发生）时，inset 补偿写入 `scrollTop`，记录 adjustment、结算前后的 inset 与写入后的 scrollTop。用于确认真机上占位块显隐不伴随内容位移；prepend 同批发生的那次由 A3/P4 覆盖，不重复记录。

13. `A6-live-tail`：live tail 尺寸变化，记录高度变化、following 重算和最终动作。
14. `A7-restore`：会话滚动记忆恢复，记录请求位置、解析位置、实际写入位置、内容高度，以及解析阶段和浏览器写入阶段是否发生 clamp。

## 所有权与边界

- `ConversationTimeline` 仍是滚动、following、测高缓存和锚点状态的唯一所有者；该所有权
  不因探针退役改变。
- 退役前的临时 helper 只负责转发观测数据，不新增状态源、不读写 `scrollTop`、不参与
  React 渲染决策；helper 已删除，不再是当前实现的一部分。
- 业务组件只调用 `packages/ui/src/logger.ts` 的现有日志出口；main 进程负责最终文件写入。
- 现有浏览器原生 `overflow-anchor` 禁用和 TanStack Virtualizer 的所有权保持不变。
- 保留的聚合诊断是 `ConversationTimeline` 的 `measureRendererPerformance`
  （`conversation.turn-frame`）与 `[ui-perf]` 链路，用于持续观测，不需要逐事件探针。

## 失败语义与清理

以下为退役前的历史语义，仅用于解释既有日志：

- 无 Desktop bridge 时 helper 静默返回；不能抛出异常或阻塞滚动。
- main 日志写入失败不能影响 UI；日志只用于诊断。

当前状态：

- 临时探针调用与 `conversationTimelineDebug.ts` 已移除，不再存在“测试完成后移除探针”
  的待办；历史日志文件在用户确认分析完成前保留，不删除、不改写。
- 不再恢复逐事件生产埋点；修复验证改用隔离测试与受控对照，收益口径见
  `conversation-update-cost.md`。
- 删除探针不得改变前插补偿、pending restore、inset 结算、用户滚动锚定与合成 scroll
  通知；真正的恢复、贴底、用户锚定和业务决策所需的 `scrollTop` 读取保留。

## 历史验收（退役前，仅存档）

以下 1、2、3 描述退役前的探针能力，不再是当前生产保证：

1. 桌面 renderer 重启后，结构化事件能继续写入 main 进程的日期日志文件。
2. 长历史快速滚动、向上触发历史前插、pending 期间继续滚动、程序化定位和二次测高至少能留下对应事件；P1–P6 能用同一 `runId/requestId` 还原一次加载从触发到所有 `scrollTop` 写入的顺序。
3. 埋点不包含消息正文、凭据或完整用户数据。

## 当前验收

1. 生产源码不存在 `recordConversationTimelineDebugEvent` 调用，`conversationTimelineDebug.ts`
   已删除；测试中的模块 mock 已移除。
2. 无 prepend 的 commit 不执行诊断几何读取，由 `timelinePrependEffectGeometry` 直接执行
   实际 effect 回调验证。
3. 真实前插正/负差值、inset 同批结算、restore 接管、用户滚动和会话切换行为不回归。
4. 聚合诊断 `measureRendererPerformance("conversation.turn-frame", ...)` 与 `[ui-perf]`
   仍可用；不新增长期追踪开关。
5. 历史日志保留且可读，不因文档清理而删除用户证据。
6. 无 Desktop bridge 或日志写入失败时，应用仍能正常启动和滚动。
7. `pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed` 通过。
