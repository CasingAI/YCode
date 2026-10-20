/**
 * composer 自动聚焦决策（纯函数，脱离 React/DOM 便于单测）。
 *
 * 聚焦请求分两类来源：
 * - **环境驱动**（ambient）：新建任务（startDraft 递增 draftFocusVersion）/ 切换会话
 *   （sessionId→scope 变化）/ 挂载。这些不是用户"此刻想在这里输入"的表达，
 *   在手机上自动聚焦会弹出软键盘遮挡界面，因此移动端一律跳过。
 * - **用户驱动**（explicit）：队列项撤回恢复草稿、外部文本预填、代码评论「加到对话」。
 *   用户已经表达了"我要在这里输入"，聚焦是操作的一部分，移动端同样允许。
 *
 * 三态：
 * - `skip`：不聚焦，也不暂存意图。
 * - `defer`：已启用但 composer 暂不可编辑（切到连接中会话时短暂 disabled）——聚焦意图
 *   暂存，待 disabled→false 可编辑后兑现一次。
 * - `focus-now`：已启用且可编辑，立即聚焦。
 */
type ComposerAutoFocusDecision = "focus-now" | "defer" | "skip";

/** 聚焦请求的来源。 */
export type ComposerAutoFocusIntent = "ambient" | "explicit";

export interface ComposerAutoFocusOptions {
  /** 宿主门控（SessionPane.focused）：仅焦点 pane 自动聚焦。 */
  autoFocusEnabled: boolean;
  /** composer 是否不可编辑（v4：sessionId 连接中）。 */
  disabled: boolean;
  /**
   * 是否移动端（触控为主的设备）。
   *
   * 口径是「以触控为主要输入方式」而不是视口宽度：窄视口的桌面窗口没有软键盘，
   * 不该被剥夺自动聚焦；横屏手机与平板宽度可以超过窄屏断点，但照样有软键盘。
   */
  isMobileViewport: boolean;
  /** 聚焦请求来源，默认环境驱动。 */
  intent?: ComposerAutoFocusIntent;
}

export function resolveComposerAutoFocus({
  autoFocusEnabled,
  disabled,
  isMobileViewport,
  intent = "ambient",
}: ComposerAutoFocusOptions): ComposerAutoFocusDecision {
  if (!autoFocusEnabled) return "skip";
  // 用户驱动的聚焦不因移动端跳过：用户已经明确要在 composer 里输入。
  if (intent === "ambient" && isMobileViewport) return "skip";
  if (disabled) return "defer";
  return "focus-now";
}
