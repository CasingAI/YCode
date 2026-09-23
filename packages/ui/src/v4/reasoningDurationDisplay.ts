// 思考行耗时的唯一推导（纯逻辑，无 DOM/React 依赖）。
//
// 背景：思考行显示「思考 · 持续了 N 秒」。旧实现在 ai-elements/reasoning 组件内部用
// 「挂载时刻起算」的秒表（startTimeRef = Date.now()），于是切会话、虚拟列表回收、运行轮
// 在 live tail 与虚拟列表之间搬家导致组件重建时，秒表归零回到 1 秒重新爬——数字会变小。
//
// 起点其实早就在行数据里：ReasoningRow.createdAt 是必填字段，值是打开该行的
// reasoning_start 事件时间；投影闭合该行时写入的 durationMs = 闭合事件时间 - createdAt，
// 与「now - createdAt」是同一个量。所以耗时一律从行数据算，输入里不存在「组件挂载时刻」
// 这个量，重挂载改变不了结果。

const MS_IN_S = 1000;

/** 毫秒耗时转界面秒数：向上取整、最小 1 秒（不出现「0 秒」）。 */
export function reasoningDurationSecondsFromMs(elapsedMs: number): number {
  return Math.max(1, Math.ceil(elapsedMs / MS_IN_S));
}

/**
 * 思考行要显示的秒数。
 *
 * - 已闭合：用投影写入的 `durationMs`（`闭合事件时间 - createdAt`）定格。
 * - 仍在思考：用 `now - createdAt`，与闭合值同量，闭合时不跳变。
 * - 闭合但缺 `durationMs`（字段不全的旧快照）：返回 undefined，由界面走兜底文案；
 *   **不能**退化成 `now - createdAt`——那会让一个早已结束的思考随时间越显示越大。
 */
export function reasoningDurationSeconds(input: {
  createdAt: number | undefined;
  durationMs: number | undefined;
  streaming: boolean;
  now: number;
}): number | undefined {
  if (input.durationMs !== undefined) return reasoningDurationSecondsFromMs(input.durationMs);
  if (!input.streaming || input.createdAt === undefined) return undefined;
  return reasoningDurationSecondsFromMs(input.now - input.createdAt);
}
