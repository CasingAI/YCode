# Spec: 对话时间线滚动漂移临时运行时探针

## 目标

为长历史对话中的滚动漂移、偏移和闪现提供可关联的运行时证据，区分以下假设：

- **H1 测高累积**：未挂载行使用估算高度，新行异步测高后改变 virtualizer 的前缀坐标。
- **H2 prepend 双阶段补偿**：历史前插先由时间线补偿，随后 virtualizer 对真实尺寸再次补偿。
- **H3 following 竞争**：用户已离开底部时，内容变化或 live-tail 变化仍触发贴底或状态重算。
- **H4 恢复/宽度重排**：会话恢复、内容宽度变化和异步测高使临时位置被浏览器 clamp 后再次写入。

本 spec 只规定诊断观测，不规定修复方案，也不改变滚动、锚定、测高或会话状态语义。

## 运行时落点

- 复用项目已有的 `renderer → IPC → main logger` 链路，renderer 通过 UI logger 发出结构化诊断事件，main 进程写入应用日志文件。
- 应用日志按日期写入 `~/.zcode/v2/logs/YYYY-MM-DD.log`（测试环境沿用既有日志目录配置），应用重启后无需保留任何调试终端或外部服务。
- renderer 侧先以 50ms 窗口批量转发事件，批量内仍为每条事件保留 `sequence`；单批达到 128 条时立即 flush，避免诊断写入反过来阻塞滚动。
- 无 Desktop bridge 的 Web 环境不会产生文件日志；日志写入失败不能影响 UI。
- 不记录消息正文、用户输入、凭据或完整消息标识；只记录数量、内部索引、尺寸、偏移、状态和事件顺序。

## 事件与顺序

每个事件带 `probeId`、单调递增的本地序号；main logger 负责补充时间戳、PID 和来源。事件顺序应能还原同一次交互中的因果链：

1. `A1-measure`：virtualizer 测量行，记录测高前后的高度、索引和当前视口位置。
2. `A2-size-adjust`：TanStack 询问尺寸变化是否补偿，记录 item 范围、`scrollTop`、following、用户滚动保护/锚点状态和判定结果。
3. `A3-prepend`：历史前插 commit，记录前插基线、候选稳定 key 是否存在、最终调整量和写入前后位置。
4. `A4-content-anchor`：内容高度变化后的 layout effect，记录 following 重算结果、宽度变化状态、用户锚点聚合校正和最终动作。
5. `A5-scroll`：`scroll` 事件，记录来源、用户意图、following、视口和离底距离。
6. `A6-live-tail`：live tail 尺寸变化，记录高度变化、following 重算和最终动作。
7. `A7-restore`：会话滚动记忆恢复，记录请求位置、解析位置、实际写入位置、内容高度，以及解析阶段和浏览器写入阶段是否发生 clamp。

## 所有权与边界

- `ConversationTimeline` 仍是滚动、following、测高缓存和锚点状态的唯一所有者。
- 临时 helper 只负责转发观测数据，不新增状态源、不读写 `scrollTop`、不参与 React 渲染决策。
- 业务组件只调用 `packages/ui/src/logger.ts` 的现有日志出口；main 进程负责最终文件写入。
- 现有浏览器原生 `overflow-anchor` 禁用和 TanStack Virtualizer 的所有权保持不变。

## 失败语义与清理

- 无 Desktop bridge 时 helper 静默返回；不能抛出异常或阻塞滚动。
- main 日志写入失败不能影响 UI；日志只用于诊断。
- 本轮测试完成后，必须移除所有临时探针调用；日志文件在用户确认分析完成前保留。
- 若后续修复，修复验证期间保留探针，并使用 `post-fix` 标记区分验证批次。

## 验收标准

1. 桌面 renderer 重启后，结构化事件能继续写入 main 进程的日期日志文件。
2. 长历史快速滚动、向上触发历史前插、内容宽度变化、流式 live-tail 和会话恢复至少能留下对应事件。
3. 无 Desktop bridge 或日志写入失败时，应用仍能正常启动和滚动。
4. `pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed` 通过。
5. 埋点不包含消息正文、凭据或完整用户数据。
