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

import type { Locale } from "@zcode/shared";

const MS_IN_S = 1000;
const SECONDS_IN_MINUTE = 60;

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
 * 秒数到「M 分 S 秒」的单位组装，不带两态措辞。
 *
 * 超 60 秒时把整数秒拆成「M 分 S 秒」（整分不带「0 秒」），`<60s` 保持「X 秒」。
 * 拆分只发生在显示组装层：输入已经是向上取整后的秒数，这里不再重新取整，
 * 闭合瞬间不会因为进位方式不同而跳变。
 *
 * 耗时（`formatDurationLabel`）和 TaskOutput 的等待预算共用这套拆分，所以「M 分 S 秒」
 * 的口径只有一处；需要自带措辞的调用方用本函数再拼自己的 message id。
 */
export function formatDurationUnits(
  intl: DurationMessageFormatter,
  input: { seconds: number; locale: Locale },
): string {
  const join = input.locale === "zh-CN" ? " " : "";
  const minuteUnit = intl.formatMessage({ id: "chat.history.duration.minute" });
  const secondUnit = intl.formatMessage({ id: "chat.history.duration.second" });
  // 85 秒显示「1 分 25 秒」而不是「85 秒」。
  const minutes = Math.floor(input.seconds / SECONDS_IN_MINUTE);
  const seconds = input.seconds % SECONDS_IN_MINUTE;
  if (minutes <= 0) return `${input.seconds}${join}${secondUnit}`;
  if (seconds <= 0) return `${minutes}${join}${minuteUnit}`;
  return `${minutes}${join}${minuteUnit} ${seconds}${join}${secondUnit}`;
}

/**
 * 耗时的两态措辞。运行中是一个正在持续的过程（「持续了 N 秒」），结束后是一次已完成的
 * 测量（「耗时 N 秒」）——两种措辞回答的是同一个数字在不同阶段的两种语义。
 *
 * 秒数拿不到时返回 undefined，调用方整段不渲染耗时元素，不退化成模糊区间。
 */
export function formatDurationLabel(
  intl: DurationMessageFormatter,
  input: { seconds: number | undefined; running: boolean; locale: Locale },
): string | undefined {
  if (input.seconds === undefined) return undefined;
  const duration = formatDurationUnits(intl, {
    seconds: input.seconds,
    locale: input.locale,
  });
  return intl.formatMessage(
    {
      id: input.running ? "chat.timeline.duration.running" : "chat.timeline.duration.elapsed",
    },
    { duration },
  );
}
