// 对话时间线行耗时的唯一推导（纯逻辑，无 DOM/React 依赖）。
//
// 背景：思考行与工具行都显示耗时。旧实现在 ai-elements/reasoning 组件内部用「挂载时刻起算」
// 的秒表（startTimeRef = Date.now()），于是切会话、虚拟列表回收、运行轮在 live tail 与虚拟
// 列表之间搬家导致组件重建时，秒表归零回到 1 秒重新爬——数字会变小。
//
// 起点其实早就在行数据里：思考行是 ReasoningRow.createdAt（reasoning_start 事件时间），
// 工具行是 ToolCallRow.startedAt（ToolCallStarted 事件时间，不含审批等待）。投影闭合行时写入
// 的 durationMs = 终点 - 起点，与「now - 起点」是同一个量。所以耗时一律从行数据算，输入里
// 不存在「组件挂载时刻」这个量，重挂载改变不了结果。
//
// 思考行口径见 docs/specs/reasoning-duration.md，工具行见 docs/specs/tool-call-duration.md。

const MS_IN_S = 1000;

/** 毫秒耗时转界面秒数：向上取整、最小 1 秒（不出现「0 秒」）。 */
export function conversationDurationSecondsFromMs(elapsedMs: number): number {
  return Math.max(1, Math.ceil(elapsedMs / MS_IN_S));
}

/**
 * 行要显示的秒数。
 *
 * - 已闭合：用投影写入的 `durationMs`（`终点事件时间 - 起点`）定格。
 * - 仍在进行：用 `now - startedAt`，与闭合值同量，闭合时不跳变。
 * - 闭合但缺 `durationMs`（字段不全的旧快照），或从未真正开始（工具行没有 `startedAt`）：
 *   返回 undefined，由界面不渲染耗时元素；**不能**退化成 `now - startedAt`——那会让一个
 *   早已结束的行随时间越显示越大。
 */
export function conversationDurationSeconds(input: {
  startedAt: number | undefined;
  durationMs: number | undefined;
  running: boolean;
  now: number;
}): number | undefined {
  if (input.durationMs !== undefined) return conversationDurationSecondsFromMs(input.durationMs);
  if (!input.running || input.startedAt === undefined) return undefined;
  return conversationDurationSecondsFromMs(input.now - input.startedAt);
}

/** 与 `IntlProvider` 的 intl 同形，只取文案需要的那一面。 */
export interface DurationMessageFormatter {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
}

/**
 * 耗时的两态措辞。运行中是一个正在持续的过程（「持续了 N 秒」），结束后是一次已完成的
 * 测量（「耗时 N 秒」）——两种措辞回答的是同一个数字在不同阶段的两种语义。
 *
 * 秒数拿不到时返回 undefined，调用方整段不渲染耗时元素，不退化成模糊区间。
 */
export function formatDurationLabel(
  intl: DurationMessageFormatter,
  input: { seconds: number | undefined; running: boolean },
): string | undefined {
  if (input.seconds === undefined) return undefined;
  return intl.formatMessage(
    { id: input.running ? "chat.timeline.duration.running" : "chat.timeline.duration.elapsed" },
    { seconds: String(input.seconds) },
  );
}
