// 回合过程的展示词汇：桶、计数与文案组装。
// 只放纯函数与类型，不引 UI 依赖，单测可以直接覆盖计数顺序与文案选择。

import type { ToolCallActivity } from "@/lib/toolCallActivity.js";

export type ExploreActivityBucket = Exclude<ToolCallActivity, "unknown">;
export type ProcessBucket = ExploreActivityBucket | "terminal" | "changes" | "reasoning";
export type ProcessCountBucket = ProcessBucket;
export type ProcessCounts = Record<ProcessCountBucket, number>;

/** 展示顺序：文件查阅细分、网页查阅细分 → 终端 → 编辑 → 思考。 */
export const TURN_PROCESS_BUCKETS: readonly ProcessCountBucket[] = [
  "file-search",
  "file-find",
  "directory-list",
  "file-read",
  "web-search",
  "web-read",
  "terminal",
  "changes",
  "reasoning",
];

const TURN_PROCESS_BUCKET_MESSAGE_IDS: Record<ProcessCountBucket, string> = {
  "file-search": "chat.toolCall.process.fileSearch",
  "file-find": "chat.toolCall.process.fileFind",
  "directory-list": "chat.toolCall.process.directoryList",
  "file-read": "chat.toolCall.process.fileRead",
  "web-search": "chat.toolCall.process.webSearch",
  "web-read": "chat.toolCall.process.webRead",
  terminal: "chat.toolCall.process.terminal",
  changes: "chat.toolCall.process.changes",
  reasoning: "chat.toolCall.process.reasoning",
};

/** 与 `IntlProvider` 的 intl 同形，只取文案需要的那一面。 */
export interface ProcessMessageFormatter {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
}

/**
 * 组装收起态文案。计数为 0 的桶不出现；全部为 0 时返回空串，调用方不该渲染过程行。
 * 单复数由调用方按 count 选 `.one` / `.other`，与仓库其它计数文案一致。
 */
export function formatProcessText(intl: ProcessMessageFormatter, counts: ProcessCounts): string {
  const parts: string[] = [];
  for (const bucket of TURN_PROCESS_BUCKETS) {
    const count = counts[bucket];
    if (count <= 0) continue;
    const id = `${TURN_PROCESS_BUCKET_MESSAGE_IDS[bucket]}.${count === 1 ? "one" : "other"}`;
    parts.push(intl.formatMessage({ id }, { count }));
  }
  return parts.join(" · ");
}
