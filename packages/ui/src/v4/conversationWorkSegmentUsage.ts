import type { WorkSegmentUsage } from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { Locale } from "@zcode/shared";
import type { AssistantWorkRow } from "./conversationTurnFlowItems.js";
import { formatConversationWorkDuration } from "./conversationWorkDuration.js";

/**
 * 旧快照没有 `TurnWorkSegment.usage` 时的兜底统计：只算当前段可直接证明的行。
 *
 * 兜底**不**用本地时钟推算 streaming reasoning 的耗时——协议规定时间戳一律是 CLI 时钟，
 * 客户端拿本地时钟与协议 Timestamp 相减会算出错误秒数。运行中的思考耗时由 CLI 投影
 * 实时写入 `usage`，本函数只负责没有权威值时的可证明部分。
 */
export function deriveDirectWorkSegmentUsage(rows: readonly AssistantWorkRow[]): WorkSegmentUsage {
  let toolCallCount = 0;
  let reasoningDurationMs = 0;

  for (const row of rows) {
    if (row.kind === "toolCall") {
      toolCallCount += 1;
    } else if (row.kind === "reasoning") {
      if (row.durationMs !== undefined && Number.isFinite(row.durationMs)) {
        reasoningDurationMs += Math.max(0, row.durationMs);
      }
    } else if (row.kind === "subagent" && row.usage) {
      toolCallCount += row.usage.toolCallCount;
      reasoningDurationMs += row.usage.reasoningDurationMs;
    }
  }

  return { toolCallCount, reasoningDurationMs };
}

export function resolveWorkSegmentUsage(input: {
  usage?: WorkSegmentUsage;
  rows: readonly AssistantWorkRow[];
}): WorkSegmentUsage {
  return input.usage ?? deriveDirectWorkSegmentUsage(input.rows);
}

/**
 * 两个指标各自独立隐藏：次数为 0 不显示该项，耗时为 0 也不显示该项，
 * 两项都没产生时整段为空。
 *
 * 「工具 0 次」是噪声而不是信息——用户问的是「做了多少事」，
 * 0 次不构成一个答案。工作段在 agent 轮次开始时就已经存在，
 * 此时显示一行零值只会让人以为统计坏了。
 */
export function formatWorkSegmentUsage(
  usage: WorkSegmentUsage,
  intl: IntlInstance,
  locale: Locale,
): string {
  const parts: string[] = [];
  if (usage.toolCallCount > 0) {
    const toolMessageId =
      usage.toolCallCount === 1
        ? "chat.history.toolCallCount.one"
        : "chat.history.toolCallCount.other";
    parts.push(intl.formatMessage({ id: toolMessageId }, { count: usage.toolCallCount }));
  }
  if (usage.reasoningDurationMs > 0) {
    const thinkingDuration = formatConversationWorkDuration(
      usage.reasoningDurationMs,
      intl,
      locale,
    );
    if (thinkingDuration) {
      parts.push(
        intl.formatMessage({ id: "chat.history.thinkingDuration" }, { duration: thinkingDuration }),
      );
    }
  }
  return parts.join(" · ");
}
