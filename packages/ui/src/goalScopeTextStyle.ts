/**
 * goal 目标正文的视觉高亮（docs/specs/goal-command-scope-and-decoration.md「装饰（纯视觉）」）。
 *
 * 只有颜色与字重，没有下划线：命令芯片的装饰覆盖不到 `::before` 图标（装饰按 text fragment
 * 绘制，原子内联盒会截断传播），线天生在图标左边断开；zcode 原版其它命令也一律不带线。
 * 高亮统一成「命令蓝 + 中等字重」这一种形态。
 *
 * 目标正文一侧由这里提供：编辑器（Lexical TextNode 的 inline style）与用户气泡（span 的
 * inline style）引用同一份声明，两侧各写一份就会漂移。色值挂在既有的
 * `--color-command-node-foreground` 上，四套主题自动跟随，与命令芯片同一支色。
 *
 * 单独成文件是为了不依赖 React 也不依赖 `@/` 别名：编辑器的 Lexical 侧与气泡的 React
 * 侧都能直接引入，测试也能单独覆盖这份声明本身。
 */
export const GOAL_SCOPE_TEXT_STYLE = {
  color: "var(--color-command-node-foreground)",
  fontWeight: 500,
} as const;

/** camelCase → kebab-case。 */
function toCssPropertyName(property: string): string {
  return property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/**
 * Lexical 的 `TextNode.setStyle()` 只吃 cssText，这里从同一份样式对象序列化，
 * 而不是另写一份字符串——正是「样式和字符串两条真相互相漂移」的来源。
 */
export const GOAL_SCOPE_TEXT_CSS_TEXT = Object.entries(GOAL_SCOPE_TEXT_STYLE)
  .map(([property, value]) => `${toCssPropertyName(property)}: ${value};`)
  .join(" ");
