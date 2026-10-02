// 放在独立叶子模块：流中增量执行（runtime/methods）与流后分组执行（executor）都要用
// 同一句取消文案，直接互相 import 会形成循环依赖。
// 同一条 stop 边界，模型看到的说明不能分叉。
export const TOOL_CANCELLED_AFTER_TURN_STOP =
  "Tool cancelled because a previous tool result requested a turn stop.";
