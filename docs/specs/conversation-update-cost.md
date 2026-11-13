# Spec：会话更新成本与渲染派生稳定化

> 状态：首批修复已实现，受控验证完成；原完整场景未复测，原完全归因未完成。本文固定
> 范围、所有者、验证方法、受控结果与不可声称边界；受控结果不代表完整性能结论。
>
> 后续独立范围见 `docs/specs/renderer-interaction-layout-cost.md`；本文既有结果保持不变。

## 1. 背景与目标

会话切换与连续更新时，Renderer 主线程上持续出现同步 React 更新、DOM 提交、
折叠内容测量与同步布局。首批只处理已经能在源码和独立隔离测试中定位的无效工作：

1. 临时滚动诊断读取进入每次提交的热路径。
2. Radix Select / ScrollArea 的固定样式 `innerHTML` 在重复 render 中反复写入。
3. `SessionPane` 的 `knownSessionIds` 与 `pendingGuideProjection` 在无关输入变化时
   产生新的对象引用，打穿下游浅比较。
4. 切换时折叠内容与首次几何读取造成的可量化布局放大，属于后续独立范围，不在
   首批盲改。

目标是在**不改变业务事实、协议、持久化和交互语义**的前提下，消除上述已确认的
无效计算与无效 DOM 写入，并为后续对照测量提供稳定基线。

## 2. 证据等级与不可声称范围

已确认（有源码位置或隔离调用证据）：

- `ConversationTimeline.tsx` 的 prepend `useLayoutEffect` 在判断是否发生前插之前读取
  `scrollTop`；该读取只服务于诊断日志，不参与补偿计算。
- Radix Select 与 ScrollArea Viewport 每次 render 重新创建 `{ __html: 固定CSS }`
  对象，React 按对象引用判定属性变化，因此对同一固定 CSS 反复走
  `updateProperties → setProp → innerHTML`。隔离调用原构建的更新函数时，100 次新
  包装对象产生 100 次 setter 调用，稳定包装对象后为 0 次。
- `knownSessionIds` 依赖数组包含索引元数据与任务缓存对象；活动时间、标题或状态
  变化即使 ID 成员不变也会重建 `Set`，并经 `rowContext` 进入时间线。
- `pendingGuideProjection` 每次 render 都创建新投影，空 `pendingGuides` 也不是稳定引用。

这些缺陷已在当前工作区按第 4 节修复；本节描述的是修复前证据，不代表修复后的性能结果。

仍未证实（不得升级为归因结论）：

- 原 trace 的 `ParseHTML` 没有目标节点、标签名或写入内容，不能断言全部来自上述两个
  Radix Viewport，也不能断言批次数对应 Select 个数。
- 长 React 工作之前出现的 RPC handler 没有记录消息类别，不能全部称为会话 frame。
- 现有实现已有 state-only rows 引用与已完成轮增量缓存，不能声称每个 frame 都让全部
  历史行重渲染。
- 修复引用稳定性与固定样式写入后的实际收益，必须由受控对照测量给出；不能预先
  给出百分比，也不能把分项收益直接相加。
- 原 trace 已确认的解析与布局成本不能完整解释剩余 React 协调成本。

本 Spec 不声称整段会话卡顿已完全归因或已修复。

## 3. 状态所有者与边界

```text
Desktop continuous ───────────┐
                             ├─ 既有 transport / recovery 守卫
Mobile replayable + gap 修复 ─┘             │
                              ConversationProjectionStore
                              （客户端权威投影，继续逐帧应用）
                                           │
                                 SessionPane 派生输入
                              （按实际内容稳定引用）
                                           │
                                React render / DOM commit
                                           │
                              ConversationTimeline 滚动 owner
                              （只执行必要测量与单笔补偿）
```

| 事实                                         | 所有者                                 | 本批约束                                    |
| -------------------------------------------- | -------------------------------------- | ------------------------------------------- |
| accepted input / 队列 admission              | CLI/runtime `CommandInbox`             | UI 不新增队列副本，不暂停消费               |
| 会话投影、订阅序号、recovery / stale 守卫    | `ConversationProjectionStore`          | 不丢帧、不延后 ACK、不改变逐帧应用          |
| 引用存在性集合                               | `SessionPane` 只读派生 memo            | 只稳定引用身份，不是 owner / accepted queue |
| 待引导投影                                   | `projectPendingGuideQueue` + 只读 memo | 只读分流，不产生事实，不持有 accepted queue |
| 滚动、following、测高、restore、prepend 补偿 | `ConversationTimeline`                 | 保持唯一所有者，单笔写入                    |
| 固定样式 DOM 属性                            | 已锁定的 Radix Viewport                | 只稳定包装对象，不改 CSS 内容与节点语义     |

- 身份隔离继续使用 `workspaceIdentity?.trim() || workspacePath`，并保留现有
  `remoteSessionId` 路由；派生输入的作用域按字段比较（归一化 identity、
  `remoteSessionId`、`sessionId`），不采用 `scopeKey` 拼接，也不复用 `SessionPane`
  其他用途的 `scopeKey`。
- `sessionPaneDerivedInputs.ts` 中的 `buildKnownSessionIdSet`、`stabilize*`、
  `useStable*` 只负责只读派生 memo：不拥有 accepted input、队列准入、dispatch 状态
  或持久化事实；成员真值仍来自索引、任务缓存与权威 `snapshot.queue`。
- Desktop `desktop-continuous` 与手机 / Web `web-remote-replayable` 共用同一
  renderer 派生链；本批只改变派生引用与 DOM 副作用，不改变两种投递语义、恢复顺序、
  快照或队列边界。
- 不修改协议、投影 store、runtime、Host、relay、持久化或命令链路。

## 4. 首批修复

以下三项已在当前工作区落地；每条约束既是设计边界，也是回归验收依据。最终性能
收益不在此处断言。

### 4.1 临时滚动诊断退出生产热路径

- 已移除 `ConversationTimeline.tsx` 中所有 `recordConversationTimelineDebugEvent` 调用，
  删除仅为诊断存在的 `requestId`、TTL 上下文、flush / cleanup timer 与
  `conversationTimelineDebug.ts` 转发 helper；测试中的模块 mock 已同步移除。
- prepend effect 先用已有内存状态判断初始挂载与真实前插；没有前插时更新
  `firstRowId` / `totalSize` 基线后返回，不为诊断读取 DOM。
- 保留真实前插的有符号 `totalSize` 差值、块容器必要测量、top inset 合并和单笔
  `scrollTop` 写入；保留 pending restore 的坐标系所有权、用户滚动校正与合成 scroll 通知。
- 不机械删除所有 `scrollTop` getter；恢复、贴底、用户锚定和业务决策所需的读取不在
  删除范围。
- 保留现有聚合诊断：`ConversationTimeline` 的 `measureRendererPerformance`
  （`conversation.turn-frame`）与 `[ui-perf]` 链路；不新增长期追踪开关。
- 历史诊断日志文件归用户所有，不删除、不改写；探针退役说明见
  `conversation-timeline-scroll-runtime-probes.md`。

验收：`timelinePrependEffectGeometry` 直接执行实际 effect 回调，无 prepend 路径的
几何 getter 调用为 0；真实 prepend、restore、inset 与用户滚动的结果保持一致。不能
只用源码字符串断言代替行为测试。

### 4.2 版本锁定补丁稳定 Radix 固定样式

- 已通过仓库现有 `pnpm.patchedDependencies` 机制登记
  `@radix-ui/react-select@2.2.6`、`@radix-ui/react-scroll-area@1.2.10` 的补丁，并同步
  更新锁文件与根 `package.json`。
- 将各包 Viewport 固定 CSS 的 `{ __html: ... }` 提升为模块级稳定对象，同时覆盖
  ESM `dist/index.mjs` 与 CommonJS `dist/index.js` 两个实际入口。
- 不修改 CSS 内容、nonce、节点结构、Select Collection 注册、关闭时的
  `DocumentFragment` portal、键盘或焦点语义；不以新增全局 CSS 代替修复。
- 构建时确认 Desktop / Web 实际解析到补丁版本。

验收：`radixViewportRerenderBrowser` 在独立生产态浏览器中，排除首次挂载与实际重新
挂载后，对已存在的开放/关闭 Select Viewport 与 ScrollArea Viewport 各做 100 次强制
重渲染，固定样式的额外 `innerHTML` setter 调用为 0；实际选项、尺寸与 nonce 变化仍按
原语义生效。该结果不得表述为“原 trace 的全部 ParseHTML 已消除”。

### 4.3 稳定 `pendingGuideProjection`

- `pendingGuideProjection.ts` 在无 guide 时返回模块级 `EMPTY_PENDING_GUIDES`，避免
  空 `pendingGuides` 每次新建。
- `sessionPaneDerivedInputs.ts` 的 `stabilizePendingGuideProjection` 在作用域字段一致
  且 pendingGuides 成员引用与顺序未变时复用旧数组；`visibleQueue` 始终由当前权威
  `snapshot.queue` 派生，不冻结旧队列。
- `useStablePendingGuideProjection` 只做只读 memo，不是状态所有者，不持有 accepted
  queue，也不参与 dispatch 或撤回胜负判定。
- 真实 guide 内容、派发状态、delivery 分流或顺序变化必须立即可见。
- 不改变 guide 与 queue 的分流规则、顺序、撤回入口、`dispatch.state`、reserved /
  promoting 行为或 `deleteQueueItem` 命令链路；不在 renderer 建立 guide 队列副本。
- 规则细节与既有原子边界见 `pending-guide-withdraw.md`。

验收：`sessionPaneDerivedInputs` 单测与浏览器用例覆盖无关 snapshot 更新时投影引用
不变；guide 新增、删除、reserved / promoting、guide → queue 以及真实队列成员变化时
投影立即更新，`visibleQueue` 始终等于当前 queue 的派生结果。

### 4.4 稳定 `knownSessionIds`

- `buildKnownSessionIdSet` 保留原并集与就绪规则（sessions-index live 项 + tasks-index
  全量任务缓存 + archived 全量订阅 + 当前会话 id）；所有来源未就绪时仍返回 `undefined`。
- `stabilizeKnownSessionIdSet` 用 `zustand/vanilla/shallow` 比较成员，忽略索引顺序与
  对象身份，但不忽略成员增删；`undefined`（未就绪或所有来源为空）与已就绪集合不能混同。
- 作用域由 `isSameDerivedInputScope` 逐字段比较：归一化 identity
  （`workspaceIdentity?.trim() || workspacePath`）、`remoteSessionId`（缺省空串）、
  `sessionId`（缺省空串）；不拼接 `scopeKey`，也不复用 `SessionPane` 其他用途的 `scopeKey`。
- 作用域改变时即使调用方传入同一个 `next` 集合引用，也返回克隆的新 `Set`，不得跨
  作用域串用；`useStableKnownSessionIdSet` 只负责只读 memo，不是 owner / accepted queue。
- 保留归档来源、fail-open 与存在性语义；详见 `assistant-session-citation.md`。
- 不重做既有 turn-unit 缓存，不扩大 `TaskListItem` comparator，不把整个 `SessionPane`
  强行 memo 作为替代。

验收：仅 `lastActivityAt`、标题或状态变化且 ID 成员不变时，`knownSessionIds` 保持
引用；真实成员变化更新引用。受控场景中，只有索引元数据变化时未变的已完成轮不新增
render；侧栏需要更新的标题/状态仍正常更新；跨作用域相同集合不得复用旧引用。

## 5. 测试

复用 `packages/ui/test/helpers/chromiumFixture.ts` 与现有 `*Browser.test.ts` 的独立
生产态构建方式；只启动测试自己的 Chromium、fixture 和 profile，不连接、注入、关闭
或重启正在运行的 YCode。环境缺失时明确报告跳过，不能写成通过。

已落地覆盖：

1. `timelinePrependEffectGeometry`：无 prepend 的 commit 不执行诊断几何读取；真实前插
   正/负差值、inset 同批结算、restore 接管、用户滚动和会话切换不回归
   （`timelineScrollAnchor`、`timelinePrependAcceptance`、`timelinePrependCommit`、
   `timelineUserScrollAnchorWiring`、`timelinePrependGateWiring`、`timelineHiddenStaging`、
   `timelineToggleAnchor`）。
2. `radixViewportRerenderBrowser`（`fixtures/radix-viewport-rerender`）：Select 开/关、
   选中文字、键盘选择、焦点恢复、nonce 与固定样式零重复写入；ScrollArea 内容变化和
   滚动条保持正确。
3. `sessionPaneDerivedInputs` 单测与浏览器用例：pending guide 新增、删除、reserved /
   promoting、guide → queue、无关 snapshot 更新的引用稳定性
   （`conversationPendingGuideWithdraw`）。
4. 会话引用成员不变/增删、归档、未就绪、跨工作区身份隔离，以及已完成轮 render
   次数（`sessionCitation*`、`conversationTurnUnitReuse`）。
5. `conversationUpdateCostBrowser`：五变体（baseline、timeline-only、radix-only、
   derived-only、combined）复用同一受控 transport/store 与真实 Timeline，复现连续更新
   中切换会话、切 Files 后返回、上翻历史和展开折叠；不以 mock 滚动算法替代实际算法。

## 6. 量化验收与对照

- 使用相同生产构建配置、固定数据和相同六次交互序列，比较未修复基线、每项单独修复
  与合并修复；预热后重复采样并报告样本数。
- **指标口径**：raw `EventDispatch` 是输入事件的处理器执行段，不等于 INP。INP 需按
  input delay + processing time + presentation delay 的独立口径采集；不得把
  `EventDispatch`、React render / commit、layout、long task 等嵌套或重叠区间相加。
- 输入等待、事件处理、后续呈现、长任务阻塞分别记录，不合成单一数值；React render
  与 DOM / browser 成本分开。`ParseHTML` 次数/时间与同步样式/布局来源单独记录。
- 同配置 trace 只用于定位；低开销对照用于检查深栈采集是否显著放大耗时。不把开发态
  Profiler 的绝对值当作生产结果。
- 分项结果只能称为该受控场景的收益；修复存在交互效应，不把独立收益直接相加，也不
  预先承诺改善百分比。
- 原始完整 YCode 场景只有在独立授权实例或用户提供的新采样下才能验证；未经授权不
  操作当前实例。拿不到完整复测时，交付中明确区分“缺陷修复已验证”与“原场景改善
  尚未验证”。

## 7. 验证结果、状态与已知问题

### 7.1 状态

- 首批修复：已实现（4.1–4.4 均已在当前工作区落地）。
- 受控验证：已完成（五变体生产态对照、定向回归与工程检查）。
- 原完整 YCode 场景：未复测。
- 原卡顿的完全归因：未完成。本 Spec 只证明已识别缺陷的修复与该受控场景中的行为，
  不对整段会话卡顿作完整归因。

组合变体已接入 `sessionPaneDerivedInputs.ts` 的真实
`useStableKnownSessionIdSet` / `useStablePendingGuideProjection`，不是等价 mock。
五变体（baseline、timeline-only、radix-only、derived-only、combined）各执行
warmup 1 次、measured 3 次，全部通过。

最终质量门禁另以固定 baseline 只跑 baseline + combined，各 1 次 measured、0 次
warmup、trace 关闭，5 项用例全部通过。该单样本结果只作最终回归门禁，不替代上述
三样本对照，也不据此更新收益结论。

### 7.2 受控场景结果

| 检查                              | baseline                              | combined |
| --------------------------------- | ------------------------------------- | -------- |
| 固定 CSS `style.innerHTML` setter | 200 次（Select 100 + ScrollArea 100） | 0 次     |
| 仅元数据变化的已完成轮 rerender   | 22 次                                 | 0 次     |

- 固定样式检查排除首次挂载与实际重新挂载；100 次是各被测组件执行的强制更新次数，
  不是生产环境调用次数。
- prepend 路径的诊断专用几何 getter 已移除；最终 smoke 的 `scrollTopGets` 为 baseline
  4 / combined 4，属必要业务读取，不能据此宣称 Timeline 不再读取布局。严格的
  effect 级证据只覆盖无 prepend 提交的几何读取为 0。
- EventTiming duration（pooled steps）：三样本对照为 baseline 148 ms、combined 148 ms。
  最终单样本门禁为 192 ms / 196 ms，只证明链路可运行，不构成前后对比。该指标没有
  下降，不能据此宣称事件处理整体改善。
- 以上是固定数据与生产态构建下的受控结果，只说明该场景中对应无效工作被消除；不能
  外推为原 trace 全部 `ParseHTML` 或整段会话卡顿的收益。
- trace 只用于定位；本文不记录 trace 数值，也不以单项 trace 论证整体收益。

### 7.3 工程检查

- 最终定向 smoke：4 项聚合纯测试（样本说明、CDP 秒→毫秒、基线哈希不匹配、trace
  主线程口径）加 baseline + combined 矩阵，5 项全部通过；baseline 与 combined 各
  1 次 measured、0 次 warmup、trace 关闭。该 smoke 中固定 CSS setter 200 → 0、
  仅元数据变化的已完成轮 rerender 22 → 0，restore drift 与 baseline 同源。
- `conversationUpdateCostBrowser` 在 trace 关闭时 `traces` 可缺省，测试只在存在
  trace 样本时校验并输出诊断，不再默认解引用。
- 全量 UI：2869 total，2864 pass，4 fail，1 skip（新增 4 项聚合纯测试；成本矩阵无
  baseline 时显式 skip）。4 项失败均在本任务未修改的文件：
  `conversationStatusPanelTooltipTrigger` 的 Windows 路径相关 1 项；
  `elicitationDesktopCollapse` 的 CRLF 相关 3 项。不能把这 4 项算作本批修改通过。
- `pnpm typecheck`：通过（0 错误）。
- `pnpm lint`：0 errors、78 warnings。
- `pnpm architecture:check --changed`：0 违规。UI 仍是 unmanaged 模块，零违规不等于
  全部设计已获架构验证。
- 任务文件的 `oxfmt --check`、`git diff --check`：通过；仓库既有 `fmt:check`
  基线问题不在本批格式化范围。

### 7.4 基线可移植性

- 修复前基线由会话在 OS 临时目录创建私有副本（`os.tmpdir()` 下，不加入仓库）。
  运行时通过环境变量 `YCODE_UPDATE_COST_BASELINE` 指定基线 manifest；目录或文件
  形式以 `conversationUpdateCostBaseline.ts` 当前实现为准。
- manifest 记录基线源码与依赖哈希，供 baseline、timeline-only、radix-only、
  derived-only、combined 五变体对照。实际产物与大结果文件路径只在会话最终交付中
  提供，不写入长期 spec。
- 既有 trace 记录了大量 `ParseHTML` 与 Timeline 诊断读取点触发的同步样式/布局；这些
  是基线证据，不是修复收益，也不能解释剩余 React 协调成本。
- Node 版本与工作区新鲜度检查以仓库 `mise.toml` 和脚本为准，不在本文固化机器路径或
  某次提交号。

### 7.5 已知既有问题（非本次修复引入）

- 组合 fixture 与 baseline 都存在滚动恢复 drift：切回会话时先写回记忆 `scrollTop`，
  虚拟列表重新测高后首可见 turn 前进。受控样本观察到约 +440 px、首可见 turn 从 11
  前进到 15。这是既有问题观察，不是性能收益，也不能解释为正确的 restore 语义。
- 验收只要求修复后像素偏移与 turn 漂移不劣于 baseline，不额外放宽容差；不得把 drift
  美化为正确 restore，也不得为消除它顺手修改产品。

## 8. 明确不做

- 不暂停 `ConversationProjectionStore` 消费、不丢帧、不延后 ACK、不新增队列副本。
- 不修复 baseline 同源的 restore drift，不把它断言为正确语义。
- 不做隐藏保活视图的 `display:none` 或卸载、不改 Slot / 测量约束。
- 不全局删除 Collapsible 尺寸读取或动画，不在首批修改首绘测量。
- 不下沉运行时钟，不改 `activeMs` / `endedAt` / running 工时语义。
- 不为 Files 测量增加 `setTimeout` 兜底或局部布局隔离。
- 不用 raw `EventDispatch` 冒充 INP，不把并行或嵌套耗时相加。
- 不新增跨协议 frame 关联、长期节点注册表或全局 setter 拦截。
