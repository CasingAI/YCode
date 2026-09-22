// 回合过程汇总的展示词汇：桶、计数与文案组装。
// 只放纯函数与类型，不引 UI 依赖，单测可以直接覆盖计数顺序与文案选择。

export type TurnSummaryBucket = "explore" | "terminal" | "changes" | "reasoning";

export type TurnSummaryCounts = Record<TurnSummaryBucket, number>;

/** 展示顺序：查阅 → 终端 → 编辑 → 思考，与过程发生的常见次序一致。 */
export const TURN_SUMMARY_BUCKETS: readonly TurnSummaryBucket[] = [
  "explore",
  "terminal",
  "changes",
  "reasoning",
];

const TURN_SUMMARY_BUCKET_MESSAGE_IDS: Record<TurnSummaryBucket, string> = {
  explore: "chat.toolCall.turnSummary.explore",
  terminal: "chat.toolCall.turnSummary.terminal",
  changes: "chat.toolCall.turnSummary.changes",
  reasoning: "chat.toolCall.turnSummary.reasoning",
};

/** 与 `IntlProvider` 的 intl 同形，只取文案需要的那一面。 */
export interface TurnSummaryMessageFormatter {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
}

/**
 * 组装收起态文案。计数为 0 的桶不出现；全部为 0 时返回空串，调用方不该渲染汇总。
 * 单复数由调用方按 count 选 `.one` / `.other`，与仓库其它计数文案一致。
 */
export function formatTurnSummaryText(
  intl: TurnSummaryMessageFormatter,
  counts: TurnSummaryCounts,
): string {
  const parts: string[] = [];
  for (const bucket of TURN_SUMMARY_BUCKETS) {
    const count = counts[bucket];
    if (count <= 0) continue;
    const id = `${TURN_SUMMARY_BUCKET_MESSAGE_IDS[bucket]}.${count === 1 ? "one" : "other"}`;
    parts.push(intl.formatMessage({ id }, { count }));
  }
  return parts.join(" · ");
}
