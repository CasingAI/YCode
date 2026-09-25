# Spec: 对话时间线历史加载提示

## 目标

Web 端在网络较慢、用户快速滚动到长历史顶部时，历史分页请求会进入 pending 状态，但当前时间线没有可见反馈。本规范要求在共享 `ConversationTimeline` 中显示一个轻量的“正在加载更早消息...”提示。

本次只补可见状态，不改变历史分页协议、请求错误语义、重试策略或 `hasMore` 处理。

## 现状与根因

时间线接近顶部时由 `ConversationTimeline.handleScroll` 触发 `onLoadOlder`；`ConversationProjectionStore.loadOlder` 会在发起 `rowsRange` 请求前同步设置 `loadingOlder=true`，并在请求结束时恢复为 `false`。

当前 `loadingOlder` 只用于：

- 时间线根节点的 `data-loading-older` 诊断属性；
- 可选问题导航的 `aria-busy`。

问题导航在 Web 窄屏、功能关闭或问题数量不足时不会出现，导航本身也没有可见 spinner。因此慢网络只会让不可见状态持续更久，并不会让用户看到请求正在进行。

## 产品规则

1. `loadingOlder=true` 且 `canLoadOlder=true` 时，滚动视口顶部显示 spinner 和本地化文案“正在加载更早消息...”。
2. 提示使用覆盖式布局，不进入虚拟列表的正常文档流，不改变 `totalSize`、`scrollMargin`、prepend 锚点或当前可见 turn 的坐标。
3. 提示使用已有 `chat.history.loadingOlderMessages` 文案，不新增本地化 key。
4. 提示使用 `TID_V4_TIMELINE_LOAD_OLDER`、`role="status"` 和 `aria-live="polite"`，并且不拦截滚动或点击。
5. 请求完成、失败或没有更多历史时，提示随 `loadingOlder` 状态消失。
6. `loadingOlder` 也被搜索、问题导航和历史补齐复用；本阶段使用事实型文案，不推断具体触发来源。
7. 日志和提示不得包含消息正文、用户输入、凭据或完整用户数据。

## 状态所有权

`ConversationProjectionStore` 继续是 `loadingOlder` 和 `canLoadOlder` 的唯一业务 owner。`ConversationTimeline` 只消费 props 并决定提示的呈现，不新增第二套请求状态、队列或计时器。

显隐条件由 `packages/ui/src/v4/timelineScrollAnchor.ts` 的纯函数统一计算：

```text
loadingOlder && canLoadOlder → 显示
否则 → 隐藏
```

## 布局与事件顺序

```text
用户接近顶部
  → store 同步设置 loadingOlder=true
  → React 渲染零高度 sticky 提示
  → rowsRange 请求 pending 期间提示保持可见
  → 请求 settle
  → store 设置 loadingOlder=false
  → 提示卸载，不改变虚拟列表内容高度
```

提示容器必须是零高度并使用内部绝对定位的视觉层；不能把它作为 `virtualHistory` 的普通前置行，否则提示出现/消失会改变虚拟窗口坐标。

## 负面边界

- 不修改 `ConversationProjectionStore`、`SessionPane`、`rowsRange` 协议或 WebSocket 传输。
- 不消费或修正分页返回的 `hasMore`，不处理空页重复请求。
- 不增加错误提示、重试按钮、超时、AbortController 或请求排队。
- 不把提示扩展到其他虚拟列表，也不增加 Web/Desktop 分支。
- 不删除现有时间线运行时探针。

## 验收标准

1. Web 慢网络长历史中快速滚到顶部，顶部可见 spinner 和本地化“正在加载更早消息...”文字。
2. 提示显示期间用户仍可滚动，首个可见 turn 不因提示出现或消失发生位置跳动。
3. 请求成功或失败后提示消失；`canLoadOlder=false` 时不显示。
4. 问题导航关闭、窄屏 Web 和桌面共享时间线都能看到提示，不依赖左侧 rail。
5. 辅助技术能读到一次状态播报，提示不阻断滚动。
6. 目标纯函数测试、`pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed` 通过。
