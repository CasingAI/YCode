# Spec: 状态面板迷你宽度发布

## 目标

状态面板的迷你形态宽度由面板内部测量内容宽度得出（胶囊宽度跟随摘要文案），并把结果发布成 `--chat-summary-panel-mini-width` 供面板壳使用。测量本身不产生业务事实，但它决定了「什么时候向 React 提交一次状态更新」，因此必须满足与时间线补齐相同的更新深度约束。

## 产品规则

### 只在宽度真实变化时发布

- 测量来源是面板内 `w-max max-w-80` 的隐藏测量节点；发布值是 `min(ceil(测量宽度), 320)`。
- 测量 effect 依赖面板模型（`model`）。父级每重渲染一次，模型引用变化就重跑一次测量。
- 只有发布值真实变化时才能调用 `setMiniWidth`。无依赖或每次 commit 重跑的测量路径不得依赖 setter updater 内返回旧值来止损：重复的 layout/passive 更新会累计 React 嵌套更新计数，最终抛 `#185`（Maximum update depth exceeded）。
- 用同一组件实例的 ref 记录已发布值，在调用 setter 之前短路。

### 调用方不得制造不稳定 props

- `ConversationStatusPanel` 是 memo 组件。`SessionPane` 传入的 `backgroundWorks` / `workflowRuns` 等数组必须是快照或稳定空引用；不得在 JSX 里写 `?? []`。
- 内联空数组每次渲染都是新引用，会击穿 memo，使面板及其测量 effect 随父级每次重渲染而重跑。缺省值由面板内的稳定空数组常量承接。

## 状态所有权

- `ConversationStatusPanel`：测量节点、已发布宽度 ref、`miniWidth` state 的唯一所有者。
- `SessionPane`：只传稳定引用；不得复制或补默认数组。

## 验收场景

1. 打开状态面板为迷你/自动形态，连续触发父级重渲染（流式消息、窗口缩放），`miniWidth` 未变化时不产生新的面板更新，不出现 `#185`。
2. 摘要文案变长导致内容宽度变化时，胶囊宽度按新值更新一次，不反复抖动。
3. 面板处于展开态（测量节点为 `display:none`）时测量值按 0 跳过，不把宽度发布成 0。
4. 复核 `SessionPane` 的状态面板调用点，`backgroundWorks`、`workflowRuns` 不出现内联 `?? []`。
