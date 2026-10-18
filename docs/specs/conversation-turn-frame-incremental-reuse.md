# Spec：对话轮渲染帧的增量复用

## 背景与目标

目前 `buildConversationTurnRenderUnitFrame` 接受 `previousFrame`，但每次仍全量物化所有对话轮。流式输出、时钟 tick 与历史补页不断更换历史轮对象引用，让 `ConversationTurnGroup` 的浅比较失效。应在不更改消息内容与位置语义的前提下复用未变化的完整轮。

## 所有者、接口与事件顺序

- 仍由各 `ConversationTimeline` 实例的 `previousUnitFrameRef` 拥有上一帧；暗处 staging、首绘与测高保留各自独立缓存，不共享可变状态。
- 唯一纯函数入口：`buildConversationTurnRenderUnitFrame(rows, { nowMs, sessionPhase, previousFrame })`。
- Desktop continuous / Web replayable 先各自产生规范化 rows：协议 delta 或恢复快照 → 按 turnId 归组 → 根据上一帧决定物化或复用 → 过滤不可显示轮 → 重新计算可显示轮的位置 → 输出帧。
- 只有 sessionPhase 相同、turnHeader 行引用不变、该轮非轮头行的序列引用逐个相等、且上一帧该轮不在运行中时，才可以复用前一帧轮对象。正在运行的轮总是重算，以刷新工时；sessionPhase 变化则整帧重新物化。
- 首末轮的位置依赖过滤后的序列，必须更新 `startsTimeline`、`isLastTurn` 与相关折叠状态；内容不变且位置无变化时保留旧 unit 引用。

## 边界和失败语义

- 无全局缓存、定时器或额外协议状态；不改变投影输入顺序、工具/Hook/工作段渲染、历史前插及滚动锚点。
- delta 更新必须以新行引用体现；不能仅凭 turnId 判定缓存命中。
- 不确定时重算，避免渲染旧消息；不应修改既有已完成轮的工时。

## 验收

- 未变更的轮在新 rows 数组和时钟 tick 后仍保留对象引用；只有更新过的或正在运行的轮重新物化。
- sessionPhase 变化、头部变化不复用相关轮；历史前插正确重算首尾位置。
- 首帧与增量帧内容一致；完整 UI 测试、类型检查、Lint、架构检查、生产构建无新增失败。
