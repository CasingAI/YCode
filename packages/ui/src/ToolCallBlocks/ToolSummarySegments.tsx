/**
 * 摘要行尾部的固定段落。工具行共用：`execute` 放耗时，`task-output` 放等待预算倒计时。
 */

/**
 * 摘要行尾部的耗时段。前导「·」跟描述与状态词分隔；整段 shrink-0，窄屏下先让描述省略。
 * 只在拿到文案时构造元素：ToolSummaryRow 用「节点非 null」判断摘要是否还有内容，
 * 传一个渲染为 null 的元素会让空容器照常渲染，在类别与箭头之间撑出一块异常空白。
 */
export function DurationLabel({ label }: { label: string }) {
  return (
    <span className="shrink-0 whitespace-nowrap font-normal text-foreground-subtlest">
      {"· "}
      {label}
    </span>
  );
}
