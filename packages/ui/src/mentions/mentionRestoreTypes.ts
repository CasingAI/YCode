import type { MentionItemData } from "@/mentions/mentionTypes.js";

/**
 * 还原路径构造 `PromptMentionNode` 所需的最小载荷。
 * 与 `PromptMentionPayload` 同形但解耦：还原时没有 description 等可选信息，
 * 直接按构造器字段组装，避免从 `nodes/PromptMentionNode` 反向 import 造成循环依赖。
 */
export interface PromptMentionPayloadShorthand {
  id: string;
  label: string;
  value: string;
  markdown: string;
  data?: MentionItemData;
}
