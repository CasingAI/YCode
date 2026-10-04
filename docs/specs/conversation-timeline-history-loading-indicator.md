# Spec: 对话时间线历史加载提示

## 目标

Web 端在网络较慢、用户快速滚动到长历史顶部时，历史分页请求会进入 pending 状态，但当前时间线没有可见反馈。本规范要求在共享 `ConversationTimeline` 中显示一个轻量的“正在加载更早消息...”提示。

本次只补可见状态，不改变历史分页协议、请求错误语义、重试策略或 `hasMore` 处理。

## 现状与根因

时间线接近顶部时由 `ConversationTimeline.handleScroll` 触发 `onLoadOlder`；`ConversationProjectionStore.loadOlder` 会在发起 `rowsRange` 请求前同步设置 `loadingOlder=true`。

`loadOlder` **只取数，不落窗口**：返回的行进 `pendingOlder` 缓冲，等滚动静止后由 `commitPendingOlder` 并入。因此 `loadingOlder` 的语义是「取数在途 **或** 已有待提交缓冲」，两者都结束才恢复 `false`。这样提示不会在「转圈消失、内容还没进来」的空档里断掉，也让 find 自动补页不会在内容尚未落入时提前收工。落窗口的时机、闸门与提交锁见 `conversation-timeline-prepend-commit-gate.md`。

当前 `loadingOlder` 只用于：

- 时间线根节点的 `data-loading-older` 诊断属性；
- 可选问题导航的 `aria-busy`；
- 顶部补页提示的显隐；
- find 自动补页与问题目录 hydration 的等待条件。

问题导航在 Web 窄屏、功能关闭或问题数量不足时不会出现，导航本身也没有可见 spinner。因此慢网络只会让不可见状态持续更久，并不会让用户看到请求正在进行。

## 产品规则

1. `loadingOlder=true` 且 `canLoadOlder=true` 时，滚动视口顶部显示 spinner 和本地化文案“正在加载更早消息...”。
2. 提示是**列表内真实占高度的块**，不是覆盖层。它的高度进入 virtualizer 的 `scrollMargin`，因此出现/消失必须同步补偿 `scrollTop`；具体规则与坐标推导见 `conversation-timeline-top-placeholder.md`。
3. 提示使用已有 `chat.history.loadingOlderMessages` 文案，不新增本地化 key。
4. 提示使用 `TID_V4_TIMELINE_LOAD_OLDER`、`role="status"` 和 `aria-live="polite"`，并且不拦截滚动或点击。
5. 缓冲提交完成、请求失败或没有更多历史时，提示随 `loadingOlder` 状态消失。提示必须在内容真正落入窗口之后才消失。
6. `loadingOlder` 也被搜索、问题导航和历史补齐复用；本阶段使用事实型文案，不推断具体触发来源。
7. 日志和提示不得包含消息正文、用户输入、凭据或完整用户数据。
8. 触发来源不唯一：除 scroll 事件接近顶部外，消息层高度变化（折叠/展开、测高收缩、占位块显隐）且布局上已在顶部同样评估预取，判定阈值与 scroll 路径共用 `shouldTriggerLoadOlder`。折叠后不足一屏的会话打开后自动补页，无需任何滚动操作。

## 状态所有权

`ConversationProjectionStore` 继续是 `loadingOlder` 和 `canLoadOlder` 的唯一业务 owner。`ConversationTimeline` 只消费 props 并决定提示的呈现，不新增第二套请求状态、队列或计时器。Store 必须先提交 prepend rows，再将 `loadingOlder` 恢复为 `false`；UI 的 pending 锚点清理依赖这个顺序。

显隐条件由 `packages/ui/src/v4/timelineScrollAnchor.ts` 的纯函数统一计算：

```text
loadingOlder && canLoadOlder → 显示
否则 → 隐藏
```

## 布局与事件顺序

```text
用户接近顶部
  → store 同步设置 loadingOlder=true
  → React 渲染顶部占位块（inset 0 → h），scrollTop 同步 +h，列表锁滚动
  → rowsRange 请求 pending 期间占位块保持可见
  → 请求 settle，行进 pendingOlder 缓冲，loadingOlder 仍为 true
  → staged 块渲染待插入 turn（负偏移隐藏、已布局）；就绪后 store 提交 prepend rows（inset h → 0）
  → store 设置 loadingOlder=false
  → 占位块卸载，锁解除；虚拟列表内容高度回到原值
```

占位块不能作为 `virtualHistory` 的虚拟行——它的高度必须在 `scrollMargin` 里统一记账，否则虚拟行会整体错位；也不能做成零高度绝对定位层，那就退回成浮层，滚到顶时给不出「列表已滚不动」的可观察信号。

## 负面边界

- 不修改 `rowsRange` 协议或 WebSocket 传输。
- 提示是列表内真实占高度的块，不参与 prepend 锚点的计算；锚点只认虚拟行。
- 不消费或修正分页返回的 `hasMore`，不处理空页重复请求。
- 不增加错误提示、重试按钮、超时、AbortController 或请求排队。
- 不把提示扩展到其他虚拟列表，也不增加 Web/Desktop 分支。
- 不删除现有时间线运行时探针。

## 验收标准

1. Web 慢网络长历史中快速滚到顶部，顶部可见 spinner 和本地化“正在加载更早消息...”文字。
2. 提示显示期间列表锁死不可滚动；首个可见 turn 不因提示出现或消失发生位置跳动。
3. 请求成功或失败后提示消失；`canLoadOlder=false` 时不显示。成功路径上提示的消失与内容落入之间不得出现空档。
4. 问题导航关闭、窄屏 Web 和桌面共享时间线都能看到提示，不依赖左侧 rail。
5. 辅助技术能读到一次状态播报。
6. 目标纯函数测试、`pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed` 通过。
7. 矮内容场景：折叠后不足一屏的会话打开后自动补页（无需任何滚动操作），占位块在内容落入后消失，不出现永久加载；补页轮次之间正文不跳位；历史补完后提示随 `canLoadOlder=false` 消失。
