// 工具行「后台 / 转后台」措辞的唯一判定（纯逻辑，无 DOM/React 依赖）。
//
// 背景：Bash 有两种进后台的方式，摘要行上要说出是哪一种。
//   - 入参带 run_in_background: true → 调用时就要求后台，执行器 spawn 完立即移交就返回；
//   - 入参没这个标记 → 前台跑满 timeout，运行时把进程移交到后台。
//
// 成因不靠执行器透传 mode（`BashBackgroundLifecycleMode` 的 explicit / auto_on_timeout 分叉
// 已经存在，两种模式产出的工具结果形状却相同），而是用「入参有没有后台标记」这一个已经
// 落在行上的事实：同一件事只留一个可能漂移的真相。
//
// 判定错了的代价不对称，所以两个标记都认：`background` 是子代理事件的既有约定，
// 将来若有工具用它表达显式后台，不必再改这里。判定不了的（只有 backgrounded、没有
// 任何入参标记）落到 "auto"——「转后台」对一个没有显式标记的运行描述不会错。

/** 入参里的显式后台标记键。任一为 true 即视为调用时就要求后台。 */
const EXPLICIT_BACKGROUND_INPUT_KEYS = ["run_in_background", "background"] as const;

export type ToolCallBackgroundKind = "requested" | "auto";

/**
 * 行的后台措辞。
 *
 * - 没有 `backgrounded` → undefined，调用方按普通工具行走耗时分支。
 * - `backgrounded` + 入参带显式后台标记 → "requested"（「后台」）。
 * - `backgrounded` + 入参无标记 → "auto"（「转后台」）。
 */
export function toolCallBackgroundKind(input: {
  backgrounded?: boolean;
  toolInput?: unknown;
}): ToolCallBackgroundKind | undefined {
  if (input.backgrounded !== true) return undefined;
  return hasExplicitBackgroundMarker(input.toolInput) ? "requested" : "auto";
}

function hasExplicitBackgroundMarker(toolInput: unknown): boolean {
  if (typeof toolInput !== "object" || toolInput === null) return false;
  const record = toolInput as Record<string, unknown>;
  return EXPLICIT_BACKGROUND_INPUT_KEYS.some((key) => record[key] === true);
}
