/**
 * 失败详情气泡的指针动作。
 *
 * - `open-and-keep`：触摸点按。状态词自己打开气泡，并挡住 Radix Tooltip trigger
 *   「click 就关闭」的语义，否则同一次点按会把刚打开的气泡又关掉。
 * - `leave-to-radix`：其余指针类型（鼠标、触控笔）。完全交给 Radix 原有语义：
 *   悬停开、按下即关。
 *
 * 判定只看指针类型，不看 `(hover: none)` 媒体查询：触屏笔记本这类同时支持 hover 的
 * 设备上，手指点按同样要能打开失败详情。鼠标路径由 Radix 自己按指针类型分流
 * （`pointermove` 对 touch 直接返回），两条路径不会互相打架。
 */
export type FailureDetailPointerAction = "open-and-keep" | "leave-to-radix";

export function resolveFailureDetailPointerAction(
  pointerType: string | undefined,
): FailureDetailPointerAction {
  return pointerType === "touch" ? "open-and-keep" : "leave-to-radix";
}
