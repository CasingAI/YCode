# Spec: 时间线用户滚动期间的测量锚点

## 目标

长历史对话中，未挂载的 turn 先以估算高度参与虚拟列表坐标计算；用户快速滚动时，新进入窗口的 turn 又会通过 `ResizeObserver` 异步测高。TanStack Virtual 在尺寸变化时可能直接改写 `scrollTop`，使多个尚未由用户触发的测量事件连续夺走滚动位置。

本规范要求：**用户正在操作时间线时，真实测高仍要进入 virtualizer 和高度缓存，但尺寸变化不能逐条直接改写 `scrollTop`；由 `ConversationTimeline` 以稳定可见 turn 的 key 和视口偏移聚合校正。**

本规范只处理长历史快速滚动的主漂移，不重做虚拟列表，不改变恢复、宽度变化、prepend、折叠或 following 的既有产品语义。

## 根因与现状

当前时序为：

```text
用户输入
  → markUserScrollIntent() 立即解除过期 following
  → 浏览器改写 scrollTop
  → 新行使用 estimateSize
  → ResizeObserver 异步测高
  → shouldAdjustScrollPositionOnItemSizeChange()
  → TanStack 对每个尺寸变化直接写 scrollTop
```

`ConversationTimeline` 是滚动、following、测高缓存和锚点状态的唯一所有者。`timelineScrollAnchor.ts` 只提供无 DOM/React 依赖的纯裁决；virtualizer 仍负责 measurement cache 和虚拟窗口计算。

## 产品规则

1. **用户滚动拥有测量补偿权**：存在有效用户滚动锚点时，异步尺寸变化不得直接调用 TanStack 的自动 `scrollTop` 补偿。
2. **测高不能丢失**：`measureElement` 仍写入稳定 turn key 的高度缓存，TanStack 仍更新 item size 和 measurement；保护只禁止未经协调的滚动写入。
3. **一次聚合校正**：同一轮测量提交后，以当前可见稳定 turn 的 key 和相对视口顶部偏移计算新的绝对 `scrollTop` 目标；用户滚动期间不按每一条上方 turn 累加写入。
4. **用户位置优先**：用户在测量完成前再次滚动时，旧锚点立即失效；校正只能针对最新一次用户位置，不能把用户拉回旧位置。
5. **不改变 following 语义**：`following` 仍只表示用户是否拥有贴底权；`following=false` 并不等于永久禁止所有测量补偿。
6. **唯一写入路径**：用户测量锚点的校正接入既有内容锚定 layout effect，与 following、prepend、恢复和折叠锚点交接；不新增第二个独立滚动 effect。
7. **无效锚点不猜测**：稳定 key 不再存在、measurement 尚未提交或数值非法时，丢弃过期校正，不使用行索引、消息正文或临时 DOM 引用猜测位置。

## 状态所有权与生命周期

`ConversationTimeline` 持有以下两个 ref，作为同一条用户测量所有权链：

- `userScrollAnchorRef`：当前用户滚动期间可见稳定 turn 的 `{ key, offsetTop }`。
- `pendingUserScrollAnchorCorrectionRef`：本轮已发生尺寸变化、等待下一次 layout commit 消费的标记。

生命周期：

1. wheel、touch、键盘或滚动条指针开始用户滚动时捕获/刷新锚点。
2. 用户来源的 `scroll` 事件更新 `scrollTop` 后再次刷新锚点。
3. virtualizer 尺寸回调看到有效锚点时返回 `false`，并标记待消费校正。
4. 既有内容锚定 layout effect 先消费校正，再按原 following 规则执行 `hold` 或 `stickToBottom`。
5. 校正完成、程序化定位、会话切换、恢复、折叠锚点接管或 prepend 接管时清除/交接用户锚点。
6. 用户输入意图按现有 TTL、触摸结束和滚动条指针结束规则失效；不使用无上限锁或新的滚动计时器。

`timelineScrollAnchor.ts` 只接收数字、key 和状态并返回校正结果，不读取 DOM、不创建计时器、不写 `scrollTop`。

## 事件顺序

```text
wheel/touch/key/pointer
  → 捕获或刷新用户测量锚点；following 仍按现有规则裁决
浏览器 scroll
  → virtualizer 先更新 scrollOffset；ConversationTimeline 记录 scrollTop 并刷新锚点
ResizeObserver
  → measureElement 缓存真实高度
  → shouldAdjustScrollPositionOnItemSizeChange 返回 false
  → virtualizer 更新 measurement，通知 React
layout effect
  → 按同一稳定 key 查新 start
  → 一次聚合校正（若仍有效）
  → 原 following/hold/stickToBottom 规则继续执行
prepend / restore / toggle
  → 放弃用户测量校正，由原 owner 接管
```

## 接口边界

### `packages/ui/src/v4/timelineScrollAnchor.ts`

新增纯逻辑：

- 用户滚动保护输入：供 `shouldAdjustVirtualizerForItemSizeChange` 判断当前尺寸回调是否属于用户滚动所有权窗口。
- 稳定用户锚点的捕获/校正结果：同 key 时按新 measurement `start` 和记录偏移计算绝对目标；key 不一致或数值非法时返回 `null`。
- 现有 `following`、宽度变化、恢复抑制和 prepend helper 保持原语义；非用户路径不改变当前 `itemEnd <= scrollTop` 判据。

### `packages/ui/src/v4/ConversationTimeline.tsx`

- 继续作为所有滚动写入和状态转换的 owner。
- 通过现有 `getVirtualItemForOffset`、稳定 `getItemKey` 和 `virtualizedUnitsRef` 获取锚点 key。
- 用户锚点校正复用现有 `markLayoutScrollGuard`、`lastObservedScrollTopRef`、导航视口同步和程序化滚动通知。
- A2 诊断增加用户意图、锚点是否有效和校正是否被消费的结构化元数据，不记录正文或用户输入。

## 失败与交接语义

- 没有有效锚点时，禁止本次尺寸回调的直接滚动写入，但不伪造新的锚点；下一次真实用户滚动会重新捕获。
- 锚点 key 消失时，优先交给已有 prepend keyed anchor；不得再叠加用户校正。
- 会话恢复、宽度重排、折叠动画和回到底底期间，沿用现有 owner 的保护/交接，不新增第二套优先级。
- 日志桥接失败只丢诊断批次，不影响滚动。

## 负面边界

- 不把 `itemEnd` 改成 `itemStart`；该项属于 TanStack 默认坐标语义，另行验证。
- 不修改默认行高估算、高度缓存容量、依赖版本或其他虚拟列表。
- 不修改 prepend keyed compensation、following 状态机、会话恢复 clamp、宽度变化、live-tail 或折叠锚点。
- 不删除临时 A1–A7 探针，直到用户确认修复验证完成。
- 不记录消息正文、用户输入、凭据或完整用户数据。

## 验收标准

1. 长历史快速向上或向下滚动时，异步测高不会产生多条未经协调的直接 `scrollTop` 跳写；可见稳定 turn 的视口位置不漂移。
2. 用户停止后没有延迟的二次跳回；回到底部、query/unit 定位仍按原语义工作。
3. 触发 loadOlder 时，prepend keyed 校正只执行一次；折叠、宽度变化、恢复和 live-tail 行为不回归。
4. A1/A2/A4/A5 日志可以证明用户滚动保护、聚合校正和 owner 交接顺序。
5. 纯函数测试、`pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed` 通过。
