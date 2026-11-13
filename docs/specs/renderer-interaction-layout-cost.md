# Spec: Renderer 交互布局成本（时间线 / 工具栏 / 侧栏）

> 状态：三项局部优化与 commit-only 通知作用域修复已实现；独立 Chromium 正式对照 matrix 已完成
> （36/36）。最终质量已执行：typecheck、lint、architecture 通过；UI 全量仍有 4 个既有基线 fail
> 与 2 个显式 skip。原完整 YCode 场景未复测。本文只固定本批的行为边界、唯一所有者、时序、失效
> 条件、测试场景、量化口径与已取得的受控结果，不声称整段会话卡顿已解决，也不把尚未执行的检查写成
> 通过。

## 1. 背景与目标

会话切换、连续更新与布局变化时，Renderer 主线程同时承担 React 更新、DOM 提交、几何读取与滚动
通知。现有 trace 已观察到长任务与输入延迟，但尚未证明某条滚动路径形成反馈循环，因此本批不以
GPU 配置、手动 GC 或全局调度改造作为入口，而是分别收敛三个已能定位的重复布局工作：

1. `ConversationTimeline` 的滚动记忆构造在一次调用内重复读取同一组尺寸，且同一批提交后的合成
   `scroll` 通知没有按元素与作用域合并。
2. `useComposerToolbarFit` 的 ResizeObserver / MutationObserver 通知可以在同一帧反复触发完整探针
   测量与属性写入。
3. `AnimatedSidePanePanel` 的 overflow effect 在普通滚动时重复读取完整尺寸与新增按钮矩形。

目标是在不改变业务事实、协议、恢复语义与用户滚动优先级的前提下，减少上述重复读取与重复通知，
并为每项改动建立可复现的行为与浏览器对照。性能目标是改进目标，不是预先承诺的收益；若只消除了
局部重复工作，交付只报告该项收益。

## 2. 范围与非目标

### 2.1 包含

- 时间线滚动记忆的单次尺寸读取与同批合成滚动通知合并。
- 工具栏后续测量的 rAF 合并、观察集合重绑条件与属性写入抑制。
- 侧栏几何缓存与滚动位置/mask 派生的分离。
- 本 Spec 要求的纯函数测试、实际回调行为测试与独立 Chromium 浏览器场景。
- 仓库外的 prechange 哈希快照，供其余代理在等同源码上构建对照。

### 2.2 明确不做

- 不连接、注入、关闭或重启正在运行的 YCode；不使用 CDP、DevTools、调试协议或 UI 自动化操作该
  实例。自动化只针对测试自行启动的独立 Chromium、fixture 与临时 profile。
- 不修改协议、`packages/shared` 类型、ACK、`ConversationProjectionStore`、runtime、Host、relay、
  持久化或命令链路；不新增 renderer 已接受命令队列。
- 不暂停投影消费、不丢 frame、不延后 ACK。
- 不重复旧五变体矩阵，不把 `conversation-update-cost.md` 的既有结论、基线数值或收益外推到本批。
- 不重做既有 turn-unit 缓存、运行时钟、稳定派生 hooks 或已落地的引用稳定化修复；不把整个
  `SessionPane` 强行 memo 作为替代。
- 不把全部更新包进 `startTransition`，不把同步测量机械改为 `useEffect`，不用新增超时掩盖时序问题。
- 不删除合成 `scroll` 通知；虚拟列表仍需同步最终真实 offset。
- 不改变首绘隐藏测高、补齐后一次就位、用户滚动优先及单笔补偿规则。
- 不通过 `display:none` 或卸载保活视图降低成本。
- 不顺带修复既有 restore drift，也不把 drift 视为正确行为；本批不得使偏移或首可见轮漂移恶化。
- 不声称整段卡顿已解决；只报告本批实际观测到的受控场景变化。
- 本阶段不提交任何生产代码，不覆盖或暂存与任务无关的现有本地改动。

## 3. 状态所有者与边界

### 3.1 唯一 owner

| 事实                                                                  | 唯一 owner                                   | 本批约束                                                                 |
| --------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| following、恢复、prepend 补偿、用户滚动锚点、所有 `scrollTop` 写入    | `ConversationTimeline`                       | 保持唯一所有者与单笔写入；尺寸快照只是同步计算输入，不是新的滚动状态来源 |
| 会话投影、订阅序号、recovery / stale 守卫                             | `ConversationProjectionStore`                | 不改变逐帧应用、ACK、快照或队列边界                                      |
| 已接受输入的 admission                                                | CLI/runtime `CommandInbox`                   | UI 不新增队列副本，不改变准入                                            |
| 工具栏紧凑布局投影（`data-composer-*`、`--composer-model-max-width`） | `useComposerToolbarFit`                      | 只拥有 DOM 布局投影；模式、模型、权限、Plan、CUA 事实仍由原 hooks 管理   |
| 侧栏 DOM 几何缓存、overflow 派生与 mask 边                            | `AnimatedSidePanePanel` 局部缓存             | 只缓存几何并派生 overflow/mask；标签列表、激活事实仍由既有 owner 管理    |
| 标签溢出预算规则                                                      | `sidePaneLayout.resolveSidePaneTabsOverflow` | 保留稳定宽度预算、60px 下限与容差规则，不重写防反馈判定                  |

### 3.2 身份与作用域

- 继续使用现有会话与工作区作用域：身份 key 统一为
  `workspaceIdentity?.trim() || workspacePath`，并保留 `remoteSessionId`；不新增手写身份格式。
- 时间线滚动记忆继续按 `scrollMemoryKey` 归属；合成通知的 pending 键必须包含滚动元素、真实会话
  作用域与调度 token，而不是只按元素或只按时间窗口。
- 工具栏与侧栏缓存的作用域是各自组件实例；组件卸载、DOM 替换或标签成员变化时必须失效。
- Desktop `desktop-continuous` 与手机 / Web `web-remote-replayable` 共用同一 renderer 渲染链；本批
  只改变布局读取、通知合并与 DOM 写入，不改变两种投递语义、恢复顺序或补偿所有权。

## 4. 状态与事件顺序

### 4.1 总体链路

```text
Desktop continuous ──────────────────┐
                                    ├─ 既有 transport / recovery
Web replayable ─ snapshot + gap 修复 ┘              │
                                         ConversationProjectionStore
                                         逐帧应用权威投影，不改变 ACK
                                                   │
                                      SessionPane / Timeline 只读渲染
                                                   │
                                      ConversationTimeline 滚动 owner
                                      必要位置写入 → 写后读取当前尺寸
                                                   │
                                      同批 microtask 通知合并
                                                   │
                                      virtualizer 读取最终真实 offset
                                                   │
                                               浏览器绘制
```

### 4.2 时间线：单次尺寸读取

`buildCurrentScrollMemoryState` 当前在一次调用内读取两次 `scrollTop`、两次 `clientHeight`、两次
`scrollHeight`。本批要求：

1. 一次读取 `scrollTop` / `clientHeight` / `scrollHeight` 到局部 `metrics`，同一份数值同时用于
   `reconcileFollowingForContentAnchor` 与返回的记忆状态，目标是把该函数自身由 6 次 getter
   降为 3 次。
2. `handleScroll` 中在确认没有位置写入、没有尺寸变更、没有跨异步边界的连续片段，可复用已读取的
   局部 metrics，减少再次构造记忆时的重复读取；一旦跨过微任务、rAF、DOM 写入或尺寸更新，必须
   重新读取。
3. 不建立跨事件尺寸缓存，不引入全局滚动写入包装器或额外 epoch 状态。
4. 所有位置写入后的记忆更新必须读取写后实际值，不能复用写前快照。
5. 保留 scope 更换前的 before-mutation 捕获与卸载 cleanup 的实时读取；pending detached restore
   仍优先于被空 DOM 钳制后的读数。
6. `wasPinnedToBottom` 的判定输入与返回的记忆字段必须来自同一组 metrics，避免同一次调用内出现
   互相矛盾的读数。

事件顺序：

```text
React commit（DOM 已更新）
  → layout effect / scroll 回调
  → 必要时写入 scrollTop（单笔）
  → 一次性读取 scrollTop / clientHeight / scrollHeight
  → 用同一 metrics 判定 following 并构造记忆
  → cache / save 到当前 scrollMemoryKey
  → 浏览器绘制
```

### 4.3 时间线：同批合成滚动通知

`notifyScrollObserversAfterCommit` 当前每次调用都排一个 microtask 并派发一次合成 `scroll`。
本批要求：

1. 同一滚动元素、同一真实会话作用域，在待执行通知 flush 前收到多个请求时，只派发一次合成
   `scroll`。
2. 合并保持在现有 microtask 时序，不移到 rAF 或 timer；派发时仍由监听者读取最终真实位置。
3. 通知作用域是**已提交事实**，不是 render 意图：`scrollNotificationScopeRef` 只能在
   `useLayoutEffect`（commit 阶段）推进，禁止在 render 阶段写 ref。该 layout effect 必须声明在
   所有 notify 入口之前，保证同一 commit 内先推进 scope 再派发。
4. 并发渲染中被放弃的 render 不得改变已提交作用域；否则 microtask flush 会把已提交 pending
   通知误判为跨作用域而吞掉。该污染已用真实 React 19 transition + Suspense 复现。
5. pending 记录绑定元素、作用域和调度 token。旧回调不能清除新请求；元素替换、卸载或真正作用域
   更换后，旧通知失效。
6. 不单独用 `windowEpoch` 判定通知失效：它可能随同一会话窗口更新而变化，不能因此吞掉仍然必要的
   最终通知。
7. 不拦截原生 `scroll`，不延长或重新激活 layout guard；真实用户滚轮、触摸、滚动条输入继续优先。

事件顺序：

```text
React commit（已提交树）
  → useLayoutEffect（声明在所有 notify 入口之前）推进 committed scope
  → prepend / inset / 程序化位置写入
  → request #1：pending = { element, committed scope, token }
  → request #2（同元素同作用域，flush 前）
  → 复用同一 pending，不新增派发
  → microtask flush
      → 元素仍为当前滚动元素且作用域未真正变化：dispatch 一次合成 scroll
      → 已替换 / 卸载 / 作用域更换：丢弃，不派发
  → 监听者读取最终真实 scrollTop / offset
  → 浏览器绘制

未提交 render（包括 transition / Suspense 中被放弃的分支）
  → 只产生切换意图，不执行 scope commit layout effect
  → 不得改变已提交 scope，也不得吞掉已提交 pending 通知
```

### 4.4 工具栏：测量调度

1. 保留挂载时在 `useLayoutEffect` 内同步首次 fit，避免未折叠布局先上屏。
2. 后续 `ResizeObserver` 与 `MutationObserver` 通知进入同一个 rAF 调度槽；同帧多个通知只做一次
   测量；清理时取消待执行帧。
3. 只有结构变化可能改变观察节点时才检查并重绑观察集合；纯 `characterData` 变化只标记需要重测，
   不反复 `disconnect` / `observe`。
4. 每次仍创建 fresh 隐藏探针，保留 `inert`、`aria-hidden`、测后删除及从完整布局重新计算的语义；
   暂不缓存探针 DOM，不改为估算宽度算法。
5. 将探针结果与真实节点当前结果比较，只有值变化才写 dataset 或 CSS 变量。应用后若确有新几何
   变化，下一帧可重新测量，但稳定结果不得持续自激。

事件顺序：

```text
挂载
  → useLayoutEffect 同步 fit 一次（单独计数）
后续通知（ResizeObserver / MutationObserver）
  → 结构变化：检查并重绑观察集合；characterData：只标脏
  → 同一 rAF 槽（已排队则不重复）
  → 每帧最多 1 个 fresh hidden probe
  → probe 从完整布局计算紧凑投影
  → 与真实节点当前值比较
      → 无变化：0 次属性写入
      → 有变化：写 dataset / CSS var
  → 若写入产生新几何，下一帧允许再测；稳定后不得自激
  → 浏览器绘制
```

### 4.5 侧栏：几何与 mask 分离

1. 保留 `resolveSidePaneTabsOverflow` 的稳定宽度预算、60px 下限与容差规则，不重写已有防反馈判定。
2. 将完整尺寸测量与滚动位置更新分开。尺寸变化时集中读取 viewport / content / 新增按钮几何，更新
   组件局部几何缓存；普通 scroll 只读取 `scrollLeft`，使用有效缓存派生 mask。
3. resize、scroll 和显式失效请求使用同一个 rAF 槽，但区分“几何脏”和“仅位置变化”。稳定尺寸滚动
   路径不读 `scrollWidth` 或按钮矩形。
4. 观察器绑定实际 DOM 生命周期。标签对象引用变化不反复拆装 observer；标签成员、标题/语言、按钮
   位置与尺寸、显隐变化都必须触发几何失效。使用最新回调输入，不能固定住旧 `tabCount`。
5. 零宽视为无法测量，不据此改变新增按钮位置；恢复可见后重测。overflow 结果改变新增按钮位置后，
   等待真实 DOM 提交及尺寸通知，再完成必要的下一轮测量，不能紧接 `setState` 读取尚未提交的新布局。
6. 激活标签的 smooth `scrollBy` 保持独立，不被 mask 调度取消或吞并。保留原有初次检测时序，不顺带
   更改面板挂载、保活及分栏规则。

状态图：

```text
[几何有效] --resize / 标签成员 / 标题 / 语言 / 按钮 / 显隐--> [几何脏]
[几何脏]   --同一 rAF 槽：集中读取完整几何--> [几何有效]
[几何有效] --普通 scroll: 只读 scrollLeft--> [几何有效]（仅更新 mask 边）
[零宽/不可测] --恢复可见或尺寸通知--> [几何脏]
```

事件顺序：

```text
几何变化（resize / 成员 / 标题 / 语言 / 按钮 / 显隐）
  → 标记几何脏，加入同一 rAF 槽
  → rAF：读取 viewport/content/新增按钮几何
  → 更新局部几何缓存，派生 overflow 与 mask
  → 若 overflow 改变新增按钮位置：等待真实 DOM 提交与尺寸通知后再测
普通 scroll
  → rAF：只读 scrollLeft
  → 使用有效几何缓存派生 mask（不读 scrollWidth / 按钮矩形）
激活标签变化
  → 独立 rAF：读取 active tab 与 viewport 矩形并 smooth scrollBy
  → 该滚动不被 mask 调度取消或吞并
```

## 5. 作用域与失效约束

### 5.1 时间线

- 滚动记忆只归属当前 `scrollMemoryKey`；作用域更换前的 before-mutation 捕获必须使用旧 DOM 实时值，
  卸载 cleanup 同理。
- pending detached restore 的 key 与当前作用域一致时，优先于被空 DOM 钳制后的读数；不能被新的
  空时间线快照覆盖。
- 通知作用域只随 commit 推进，且只有提交阶段 `useLayoutEffect` 一个写点；render 阶段不得写 scope
  ref，被放弃的 render 不改变已提交作用域。该 effect 必须在所有 notify 入口之前执行。
- 合成通知的 pending 在元素替换、卸载或真实作用域更换后失效；同一会话窗口更新（例如同一
  `scrollMemoryKey` 下窗口行集变化）不得使通知失效。
- 旧 token 的 flush 不能清除新 token 的 pending；派发前必须确认元素仍是当前滚动元素。

### 5.2 工具栏

- 观察器与 rAF 帧属于组件实例；卸载时必须 `disconnect` 并取消待执行帧。
- 结构变化才重绑观察集合；纯文本变化只标脏，避免 `disconnect` / `observe` 自激。
- 探针结果与真实节点当前值比较后再写入；稳定状态不得持续写属性或反复创建探针。

### 5.3 侧栏

- 几何缓存属于面板实例；标签成员、标题/语言、新增按钮位置与尺寸、显隐变化都必须显式失效。
- 普通滚动只允许读取 `scrollLeft`；缓存无效时先走几何测量，不得用陈旧宽度派生 mask。
- 零宽或未挂载时不得据此移动新增按钮；恢复可见后重新测量。
- 激活标签的 smooth `scrollBy` 与 mask 调度相互独立；两者不得互相取消。

## 6. 测试与验收场景

所有测试只使用仓库现有测试入口与测试自己的 Chromium；环境缺失时显式跳过并报告，不能写成通过。

### 6.1 时间线

1. **滚动记忆 getter 计数**：直接执行实际 `buildCurrentScrollMemoryState` 回调，验证单次调用读取
   `scrollTop` / `clientHeight` / `scrollHeight` 各 1 次，且返回字段与 following 判定使用同一组值。
2. **写后值**：位置写入后的记忆更新读取写后实际值，不复用写前快照。
3. **pending restore 优先级**：数据尚未到达、DOM 被钳制为 0 时，不覆盖 pending detached restore；
   恢复落地后按最终内容高度重放。
4. **作用域与卸载**：scope 更换使用 before-mutation 实时捕获；卸载 cleanup 仍能保存旧作用域。
5. **通知合并**：flush 前 N 次同元素同作用域调用只产生 1 次合成派发；过期作用域派发为 0；当前
   作用域仍正常派发；同会话窗口更新不丢通知。
6. **元素替换/卸载**：旧元素或旧 token 的 flush 不派发，也不清除新请求。
7. **virtualizer 最终 offset**：合并后监听者读取到最终真实位置，无首屏空白、重复补偿或把布局通知
   误当用户滚动。
8. **回归**：既有 `timelineScrollAnchor`、`timelinePrependAcceptance`、`timelinePrependCommit`、
   `timelineUserScrollAnchorWiring`、`timelinePrependGateWiring`、`timelineHiddenStaging`、
   `timelineToggleAnchor`、`timelinePrependEffectGeometry` 语义不回归；restore drift 不劣于 baseline。
9. **提交作用域不变量**：`scrollNotificationScopeRef` 只有一个写点且位于 `useLayoutEffect` 内，
   render 阶段无写；该 effect 声明在所有 notify 入口之前。用真实 React 19 transition + Suspense
   复现被放弃的 render 不改变已提交 scope，也不吞掉已提交 pending 通知。`timelineScrollWork`
   对应用例：
   - `通知作用域只在 layout effect（commit）中推进，render 阶段不写 ref`
   - `scope commit effect 声明在所有 notify 调用之前，同一 commit 内先推进再派发`
   - `提交前不改变通知作用域：未提交的 render 意图不会吞掉已提交通知`

### 6.2 工具栏

覆盖宽窄往返、临界宽度、中英文、模型与 CUA 入口增删、发送/停止状态、隐藏后显示；验证模式/CUA
折叠优先级、模型图标阈值、按钮不被挤出，以及焦点和 Tooltip 不因真实按钮移动而丢失。

- 挂载时首次同步测量单独计数。
- 后续同帧探针最多 1 个。
- 稳定结果的额外属性写入为 0。
- 连续多帧不在紧凑形态间振荡。
- 纯 `characterData` 变化不反复重绑观察集合。

### 6.3 侧栏

- 纯函数测试验证临界宽度与 60px 下限、容差规则不回归。
- 真实浏览器测试验证标签新增/关闭/重排、标题变化、连续缩放、两端 mask、active tab 滚入、隐藏
  恢复及新增按钮换边。
- 缓存有效时普通 scroll 的完整尺寸读取为 0。
- 几何失效后能恢复正确 mask；稳定尺寸没有持续测量。
- 临界区按钮不振荡，激活标签仍可见。

### 6.4 工程门禁

- `pnpm --filter @zcode/ui exec tsx --import ./test/helpers/registerAssetStubs.mjs --test <测试文件>`
- `pnpm --filter @zcode/ui test`
- `pnpm typecheck`、`pnpm lint`
- `pnpm architecture:check --changed`、`git diff --check`
- UI 当前是 unmanaged 模块；即使检查为零违规，也不能替代人工边界审查。

## 7. 量化口径

- 分开记录：输入等待、事件处理、后续呈现；长任务数量及阻塞量；样式/布局耗时；几何 getter、合成
  通知和位置写入次数。
- 区分 render、commit 和浏览器布局；不把包装组件 render 计数当作整棵 Timeline 的提交次数。
- 不把 `EventDispatch`、React render / commit、layout、long task 等嵌套或重叠区间相加；不把
  raw `EventDispatch` 冒充 INP。
- 既有 fixture 的 `flushSync` 数据只作为单独的同步成本实验，不代表产品正常调度，也不把
  `reactCommitMs` 当作纯 commit 时间。
- 每场景预热 1 轮、测量至少 5 轮；同一浏览器、视口、缩放、数据和交互序列，分别报告中位数、p95、
  最大值与样本量。
- 分项结果只能称为该受控场景的收益；修复存在交互效应，不把独立收益直接相加，也不预先承诺改善
  百分比。
- “事件计数”须区分合成与原生 scroll，不能要求所有 scroll 总数为 1。
- 原 trace 只作热点线索，不与新 fixture 的绝对数值直接相减；深栈采样用于归因，低开销组用于性能
  比较，并排除开启 CPU profiler 的采集启动开销。

## 8. 验证结果

**无效产物排除**：`ycode-renderer-layout-cost-1794589041934` 已作废，原因是装载污染、假 prepend、
缺 staging CSS 及外部 src drift，prechange/current 对照不成立；其中的时间与计数不得写入本 Spec。
此前 formal1 的旧数据同样不引用。正式结果只采用本轮 formal2（36/36、frozen、parity 0）产物。

### 8.1 正式 matrix 覆盖与边界

- 正式 matrix 为 `2 variant × 9 case × 2 group`（prechange/current、timeline/toolbar/sidepane、
  timing/counters）：expected 36、executed 36、missing 0、complete true；`frozen=true`、
  `sourceStableDuringBuild=true`、build problems 0、parity problems 0，`smoke=false`。
- timing 与 counters 分组独立。timing 每 case `warmup 1 + measured 5`；counters 每 case 只有
  `measured 1 + warmup 0`。不能声称 counters 跑了 5 轮，也不得用 counters 组耗时推断时间收益。
- 环境为独立 Chromium、1200×900 视口、临时 profile、受控 21 轮历史。时间线场景的 bundle 求值约
  3.7–3.9s，单独记为 `bundleEvalMs` 且不进入场景窗口；工具栏/侧栏场景约 72–77ms。窗口不使用固定
  settle，多步场景仍包含 Playwright 往返与 fixture 版本信号，时间只用于同 harness 下两变体相对比较。
- 所有 timing 行的 EventTiming `interactionEntries` 中位数为 0、`availableSamples=0`，即
  `interactionId > 0` 的条目为 0；`inputDelayMs`、`handlerMs`、`presentationMs`、`durationMs`
  全部为 `null`。这是采集缺失，不是 0ms，也不是已达标；presentation 即使出现也只是残差估计。
- 未复测原完整 YCode 会话，不能承诺消除原约 817ms 卡顿，也不能把 fixture 结果外推为产品结论。
  本轮没有新的完整 `SessionPane` 证据，不新增 React 或 `SessionPane` 变更。

各场景 `stepTotalMs` 中位数（prechange → current）与 current 长任务：

| 场景                         | step 中位（ms） | current 长任务（中位 count / total） | 结论                             |
| ---------------------------- | --------------- | ------------------------------------ | -------------------------------- |
| `timeline-switch-tail`       | 113.9 → 106.6   | 1 / 64（p95 73）                     | 仍有单条长任务，不能称长任务消失 |
| `timeline-scroll-stream`     | 15.2 → 12.3     | 0 / 0                                | 无长任务，时间差在本 fixture 内  |
| `timeline-initial-fill`      | 205 → 192.6     | 1 / 157（p95 183）                   | 初绘仍重，仍有长任务             |
| `timeline-prepend-commit`    | 274.8 → 273.9   | 0 / 0                                | 无长任务，未见时间收益           |
| `timeline-restore-away-back` | 614.8 → 605.4   | 2 / 198（p95 205）                   | 恢复仍重，仍有 2 条长任务        |
| `toolbar-width-sweep`        | 93.8 → 96.5     | 0 / 0                                | 略慢，不能称为改善               |
| `toolbar-stable-repeat`      | 37.4 → 38.4     | 0 / 0                                | 略慢，不能称为改善               |
| `sidepane-scroll-hotpath`    | 157 → 155.1     | 0 / 0                                | 时间差在本 fixture 内            |
| `sidepane-overflow-change`   | 204.3 → 203.9   | 0 / 0                                | 时间差在本 fixture 内            |

整体没有实质性时间改善。大长任务仍然存在：初绘 step 中位约 193–205ms（p95 最高 224.5ms），
switch 的 prechange 单样本长任务为 85–100ms、current 为 63–73ms；restore 仍有中位 198ms、最慢
205ms 的长任务。不能写成“长任务已消失”或“原卡顿已解决”。

### 8.2 计数与关键信号

- 时间线合成通知合并：synthetic scroll 在 switch 为 6 → 3、initial-fill 为 9 → 5、restore 为
  9 → 5；scroll-stream 保持 1。该计数来自 counters 组的单次 measured 样本。
- 时间线 scroll-stream 的 getter：current 为 `clientHeight 19 / scrollHeight 8 / scrollTop 23`，
  prechange 为 `20 / 9 / 24`；`gbcr.timeline` 13 → 13。
- 工具栏稳定态：current 无 `attributeWrites.toolbar` 键，即 0 次属性写入（prechange 10）；
  `gbcr.toolbar` 40 → 15，`clientWidth/scrollWidth` 各 10 → 5，probe appends/clones 10 → 5。
- 工具栏宽度扫掠：`attributeWrites.toolbar` 16 → 8，`gbcr.toolbar` 46 → 35，probe appends/clones
  8 → 7。
- 侧栏热路径：current 仅 `gets.sidepane.scrollLeft=9`，无 `gbcr.sidepane`、`clientWidth`、
  `scrollWidth`、`sidepaneAddButtonRects`；prechange 分别为 `gbcr 9 / clientWidth 18 /
scrollWidth 9 / addRects 9 / scrollLeft 18`。即稳定尺寸滚动不做完整几何测量。
- 侧栏几何变化：current 为 `gbcr 13 / clientWidth 13 / scrollWidth 13 / addRects 13 /
scrollLeft 13`，prechange 为 `15 / 30 / 15 / 15 / 12`。`scrollLeft` 比 prechange 多 1 次，属于
  保证 mask 边正确的保守权衡；不能声称该路径所有测量都减少。
- 真实首绘：专用 initial-fill 样本 `stagingPublishCount=1`、`firstPaintCommits=1`；restore 场景后续
  阶段会继续 publish，因此不能用 restore 的 `stagingPublishCount=3` 反推首绘。
- 受控首绘→前插链路：起始 `minRowId=51,rowCount=55`，成功前插后
  `minRowId=1,rowCount=105`；`successfulPrependCommits=1`、`attemptedPrependCommits=2`、
  `inFlightMax=1`、`firstPaintCommits=1`，不是假前插。
- 恢复：10 个 measured 样本（两变体各 5）实际值与 `restore` 均为 `scrollTop=1733`、
  `firstVisibleTurnId=s2-turn-9`，delta 全为 0px，phase 为 `completedSuccess`。

### 8.3 实现与不变量

已实现三项优化：时间线滚动记忆单次尺寸读取与同批通知合并；工具栏 rAF 合并、探针限流与写入去重；
侧栏几何缓存与普通滚动仅读 `scrollLeft`。同时实现 commit-only 通知作用域修复：scope 只在提交阶段
`useLayoutEffect` 推进，effect 声明在所有 notify 入口之前，被放弃的 render 不改变已提交 scope。
`timelineScrollWork` 的 3 个作用域回归用例已在全量 UI 中通过，当前文件共 26 个用例；全量已覆盖，
未重复执行定向用例。

### 8.4 工程门禁与最终验证

| 项                   | 状态                         | 说明                                                  |
| -------------------- | ---------------------------- | ----------------------------------------------------- |
| prechange 完整性快照 | 已完成（仓库外 OS 临时目录） | 逐文件 sha256、树哈希、HEAD 与工作区状态              |
| 正式 matrix          | 已完成                       | 36/36、missing 0、frozen、parity 0，见 8.1            |
| 最终质量门禁         | 已执行（UI 非全绿）          | typecheck/lint/architecture 通过；UI 4 fail、2 skip   |
| 原完整 YCode 场景    | 未复测                       | 需独立授权实例或用户提供的新采样；不得由 fixture 外推 |

最终质量在 `mise exec` Node 24、未设置 `YCODE_UPDATE_COST_BASELINE` 与
`YCODE_RENDERER_LAYOUT_COST_BASELINE` 的条件下执行：

- `pnpm typecheck`：exit 0。
- `pnpm lint`：exit 0，0 errors、78 warnings；任务文件无警告。
- `pnpm architecture:check --changed`：exit 0，violations 0、baseline 0。
- `pnpm --filter @zcode/ui test`：exit 1，2993 tests、2987 pass、4 fail、2 skipped、0 cancelled、
  0 todo，duration 约 81.7s。

4 个 fail 均为既有基线，文件不在本任务白名单且未修改，不修复：

- `conversationStatusPanelTooltipTrigger.test.ts:40`：Tooltip 包裹 DropdownMenuTrigger 时使用独立
  DOM 锚点。
- `elicitationDesktopCollapse.test.ts:16`：顶部整卡收起按钮不再被窄屏断点隐藏。
- `elicitationDesktopCollapse.test.ts:29`：收起摘要行在所有视口渲染。
- `elicitationDesktopCollapse.test.ts:67`：收起态拦截方向键、Tab 和 Enter，Escape 例外。

2 个 skip 均为显式环境缺失，不是通过：

- “独立浏览器对照会话更新成本：baseline/仅Timeline/仅Radix/仅派生/组合”：未找到基线副本，需将
  `YCODE_UPDATE_COST_BASELINE` 指向包含 `manifest.json` 的临时基线目录。
- “renderer 布局成本 prechange/current 对照”：未设置 `YCODE_RENDERER_LAYOUT_COST_BASELINE`。

全量 UI 已覆盖任务定向测试：工具栏独立浏览器用例、侧栏 tabs overflow 真实浏览器用例与 3 个
commit-only scope 用例均通过，因此未重复执行定向 suite。UI typecheck 不覆盖 test/fixture 的
TypeScript；现有测试仍由既有 esbuild/tsx 入口编译执行，未引入全局工具。

`git diff --check` exit 0。全部 41 个任务文件 `oxfmt --check` 通过；初次检查有 6 个任务 helper
格式不符，仅格式化这 6 个任务文件后复验通过。格式化未改变 formal2 绑定的源码：
formal2 `currentHashes` 8/8 与当前文件一致。UI 全量因上述 4 个既有基线 fail 而非全绿，不写成通过。

所有检查使用 `mise exec` 的 Node 24；正式 matrix 与最终质量检查均不包含运行中 YCode 的注入、
CDP、DevTools 或 UI 自动化操作。

## 9. 与既有规格的关系

- `docs/specs/conversation-update-cost.md` 已记录首批修复、受控结果与“原完整场景未复测”的边界。
  本文不修改其结论，也不把其五变体、基线与收益复用到本批；只沿用其独立测试 harness 的方法论
  与不可声称边界。
- 时间线滚动规则继续以 `conversation-timeline-user-scroll-anchor.md`、
  `conversation-timeline-prepend-blocks.md`、`conversation-timeline-prepend-commit-gate.md`、
  `conversation-timeline-scroll-runtime-probes.md` 为准；本文只增加读取次数与通知合并约束，不改变
  这些规格的产品规则。
- 诊断链路继续使用 `renderer-performance-diagnostics.md` 的 `[ui-perf]` 聚合与既有 stage；本批不在
  生产恢复已退役的逐事件探针，也不新增长期追踪开关。
- 侧栏标签溢出规则继续复用 `sidePaneLayout.resolveSidePaneTabsOverflow`，本文不重写预算算法。

## 10. 交付检查

- 阶段 0 交付：本 Spec、仓库外 prechange 完整性 manifest、环境与架构检查的真实结果。
- 实现交付：时间线单次尺寸读取与通知合并、工具栏 rAF 合并与写入去重、侧栏几何缓存，以及
  commit-only 通知作用域修复；对应行为测试、浏览器 fixture 与正式 matrix 已完成。
- 正式结论：局部读取、探针、属性写入与合成通知计数下降；没有实质时间收益，初绘、switch 与
  restore 长任务仍在，原完整场景未复测，不能外推为原卡顿已解决。
- 最终质量已执行：typecheck、lint、architecture 通过；UI 全量 4 个既有基线 fail、2 个显式 skip，
  不写成全绿。
- 只暂存本任务产生的改动；现有 Files 工作台、预览、协议、国际化及 package 文件等其他本地改动保持
  原样。本批 Spec 白名单为本文与 `docs/specs/conversation-update-cost.md` 的新增链接。
