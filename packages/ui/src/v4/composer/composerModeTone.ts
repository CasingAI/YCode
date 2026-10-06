/**
 * 权限轴三档（Plan / Ask / Agent）的身份色映射。
 *
 * 纯逻辑模块：无 store、协议与组件依赖，可独立单测。独立成文件而不是塞进
 * `chat-input-toolbar/display.tsx`，是因为那份会把 lucide 图标等资源拖进加载链，
 * 纯逻辑测试 import 它会炸（同 `thoughtLevelLabelIds.ts` / `conversationEditFrozenDisplay.ts`）。
 *
 * 档位色只表达「当前是哪一档」，不表达风险高低。`yolo` 此前挂在触发按钮上的
 * `text-warning` 是风险信号，已由 `ShieldAlert` 图标承担，色彩位让给档位身份。
 * 见 DESIGN.md「Session mode colors」与 `docs/specs/agent-mode-axis.md`。
 */

/**
 * 按模式内部值解析档位身份色类名，未知值返回空串（保持调用方的默认前景色）。
 *
 * 三条变体必须成套返回：ghost 按钮变体自带 `text-foreground`、
 * `hover:text-foreground`、`aria-expanded:text-foreground`，少覆盖一条就会在
 * hover 或下拉展开时被赢回去。v4 触发器此前就漏了 `aria-expanded` 那条，
 * 导致高权限档一点开下拉就掉色。
 *
 * 类名必须是源码里的**完整字面量**：Tailwind 靠扫描源码整串类名生成 CSS，
 * 模板拼接出的 `text-mode-${x}` 扫不到，三档会一起丢掉颜色。改档位色请改
 * styles.css 里的 `--color-mode-*`，不要在这里拼字符串。
 */
export function resolveModeOptionToneClass(value: unknown): string {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "plan":
      return "text-mode-plan hover:text-mode-plan aria-expanded:text-mode-plan";
    case "readonly":
      return "text-mode-ask hover:text-mode-ask aria-expanded:text-mode-ask";
    case "yolo":
      return "text-mode-agent hover:text-mode-agent aria-expanded:text-mode-agent";
    default:
      return "";
  }
}
