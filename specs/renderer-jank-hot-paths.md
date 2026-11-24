# Spec: 渲染主线程卡顿热点治理（流式合并、悬停收缩、动画底噪）

会话窗口的渲染主线程在「流式输出 + 悬停 + 常驻动画」同时存在时出现可感知卡顿。2026-11 的 Chrome Trace 实测（20.8s 窗口）：主线程 94% 占用，54 个 ≥50ms 长任务共 6.76s，全部汇入 React 同步 flush（718 次 / 9.1s）。本 spec 约束三条热点链路的目标行为、状态所有权与验收阈值。

## 范围（Scope）

- 会话投影流式帧的应用节奏（`conversationProjectionStore`）。
- v4 时间线区域的悬停层（Tooltip / HoverCard / SelectionTooltip）重渲染范围。
- 渲染进程的常驻 rAF 来源：性能诊断采样循环与 infinite CSS 动画。
- 不涉及 RPC 协议与传输层、`CommandInbox` admission、owner/lease 路由、desktop-continuous / web-remote-replayable 语义。

## 产品规则

### 流式 delta 按帧合并

- 投影 store 是流式帧的唯一应用点。delta 帧到达后先进入 pending 缓冲，在同一渲染帧（`requestAnimationFrame`，环境不支持时回退 `queueMicrotask`）内合并应用一次：一次 `applyConversationDeltas`、一次 `setState`、一轮 reconcile / transition 观察。
- 四类帧绕过缓冲立即处理，行为与合并前完全一致：
  1. `snapshot` 帧（整体替换）；
  2. `isSandboxStateOnlyFrame` 命中的 state-only 帧；
  3. `frame.toSeq <= current.seq` 的迟到/重复帧（静默丢弃）;
  4. `frame.fromSeq !== current.seq` 的断档帧（触发既有重订阅/恢复）。
- 缓冲未提交时收到 `snapshot` 帧：丢弃缓冲。snapshot 是权威尾窗，缓冲内容基于旧 base，继续应用会破坏一致性。
- 合并提交时 seq 水位推进到缓冲中最右帧的 `toSeq`；`shouldInvalidatePlanDirectory`、`shouldInvalidateQueryDirectory`、`reconnectsTail` 在合并后的 delta 列表上求值一次。
- 页面不可见（`document.hidden`）时不启用缓冲，直接应用，避免 rAF 停摆造成投影无限期滞后。
- 缓冲设有最长滞留上限（100ms）：rAF 被长任务饿死时到期强制提交，投影延迟有界。
- 合并只改变「什么时候 apply」，不改变「按什么顺序 apply」与「哪些帧被接受」；规则 1 / 2 / 2a / 2s 的判定顺序不变。

### 悬停层重渲染范围

- v4 时间线的悬停层（行内 Tooltip / HoverCard / 选区提示）触发打开或关闭时，React 重渲染范围必须限于悬停层自身子树；不得因悬停态落入父组件 state 或根部 Provider 导致时间线大范围重渲染。
- 悬停层内容组件必须 memo 隔离，trigger 侧不得在渲染路径上依赖会高频变化的 store 字段。

### 常驻动画与采样

- 空闲状态（无流式输出、无进行中操作）下，时间线不应有存活的 infinite CSS 动画；「正在生成」类动画以挂载条件收敛，随状态消失即卸载。
- 动画属性优先使用 transform / opacity（合成器路径）；动画 paint 属性（背景渐变位移动画类）的新增需说明理由。
- 性能诊断采样 rAF 循环仅在诊断模式显式开启时运行；生产默认不启动。可见性 / 聚焦闸门保留。

## 状态所有权

- 流式投影：`conversationProjectionStore` 实例是唯一所有者。pending 缓冲是该 store 的私有状态，不暴露、不持久化、不参与 selector。
- 悬停态：组件局部 state 或纯 CSS（`hover:*`），不写入 Zustand store。
- 动画：由持有动画的组件自持挂载条件；诊断采样由 `rendererPerformanceDiagnosticsRuntime` 自持开关。

## 事件顺序

```text
delta 帧（规则 2 主路径）
  └─ MessagePortProtocol.onMessage                    # 传输层，不合并
       └─ applyProjectionFrame(frame)
            ├─ snapshot / state-only / 重复 / 断档     # 直通，立即处理
            └─ 其余 delta 帧 → pendingFrames.push
                 └─ 首帧入缓冲时调度 flush（rAF / microtask / 100ms 上限）
                      └─ flush():
                           ├─ applyConversationDeltas(current, 合并 deltas)
                           ├─ seq = 缓冲最右帧 toSeq
                           ├─ 目录 revision / reconnectsTail 求值一次
                           └─ setState → reconcileOptimistic / AcceptedInput / observeModelTransition（各一轮）

缓冲未提交时收到 snapshot
  └─ pendingFrames = []（丢弃）→ snapshot 直通应用
```

## 接口

- `conversationProjectionStore` 对外接口不变（`connect`、`commitPendingOlder`、selector、topic 订阅语义均不动）。
- 新增内部私有成员：pending 帧缓冲、flush 调度句柄；不新增导出。
- 诊断采样：沿用现有启动入口，新增生产默认关闭的判定。

## 验收场景

1. 活跃流式会话（约 45 帧/秒）时，每渲染帧至多一次投影提交；连续多帧在同一 rAF 边界合并为一次 `setState`。
2. snapshot 帧在缓冲未提交时到达：缓冲丢弃，snapshot 正常应用，不丢投影、不重复应用。
3. 断档帧到达：立即触发重订阅，缓冲同时清空，恢复后投影连续。
4. 迟到/重复帧（`toSeq <= seq`）：静默丢弃，缓冲与水位不变。
5. 页面切后台再回前台：后台期间投影仍推进（不依赖 rAF），回前台无断档告警。
6. 悬停时间线行内 Tooltip / HoverCard：Profiler 捕获的重渲染范围限于悬停层自身；`pointerout`/`pointermove` 单次 EventDispatch < 50ms。
7. 空闲会话（无流式输出）录制 10s：无常驻 rAF 动画任务，诊断采样循环未运行。
8. 回归阈值（与 2026-11-24 基线 Trace 对照）：主线程 ≥50ms 长任务 < 10 个 / <1.5s；IPC 触发长任务 ≈0。
