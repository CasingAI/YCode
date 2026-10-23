// 问题导航目录侧信道（v4/conversation/queryDirectory）。
// 条目来自 CLI 投影的全量行：realUser userInput 为目录骨架，按 product turn 聚合
// assistantText 截断做 hover 摘要。协议只透传已截断的条目，renderer 不再为目录
// 拉取任何行正文；空文案的本地化兜底留在 UI 按 kind 映射，CLI 不做 i18n。
import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "./core.js";

// 与 plans 同族：只读、无状态、超时重发安全。刻意不是 v4 command——
// command 的 ACK 结果是封闭的「变更结果」判别联合，一组只读目录条目不属于那个词汇表。
// 偏斜安全：旧桌面根本不会调用这个新方法名。
export const v4ConversationQueryDirectoryParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    // Host attachment 注入的可信值；renderer 调用方省略。必须收下它——本 schema 是
    // strict 的，而 zcodeAgentService 与 rows/range 同构地注入 clientMode，漏收会让
    // 网关 parse 直接抛，整条目录侧信道静默失败（rail 因目录为空永不渲染）。
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
    // 起点游标：取 rowId > afterRowId 之后的首批 query 条目；缺省 = 从分支起点取。
    afterRowId: z.number().optional(),
    limit: z.number().min(1).max(PROTOCOL_V4_LIMITS.queryDirectoryMaxEntries),
  })
  .strict();
export type V4ConversationQueryDirectoryParams = z.infer<
  typeof v4ConversationQueryDirectoryParamsSchema
>;

export const conversationQueryDirectoryAssistantPreviewKindSchema = z.enum([
  "text",
  "running",
  "empty",
]);
export type ConversationQueryDirectoryAssistantPreviewKind = z.infer<
  typeof conversationQueryDirectoryAssistantPreviewKindSchema
>;

/**
 * 一条目录项 = 一条实用户 query。
 *
 * `turnId` 只负责把 renderer 时间线先定位到所属 product turn 容器；
 * 真正的导航锚点是稳定的 `rowId`。hover 摘要已在 CLI 截断
 *（与 renderer 旧约定的 220 字 / 2 段同口径），renderer 不再碰正文。
 */
export const conversationQueryDirectoryEntrySchema = z
  .object({
    // 稳定 row 身份；CLI 传 entityId 优先保证 entity 延续（与旧 renderer key 同规则）。
    key: z.string().min(1),
    rowId: z.number(),
    turnId: z.string().min(1),
    userPreview: z.string(),
    assistantPreview: z.string(),
    assistantPreviewKind: conversationQueryDirectoryAssistantPreviewKindSchema,
  })
  .strict();
export type ConversationQueryDirectoryEntry = z.infer<typeof conversationQueryDirectoryEntrySchema>;

export const v4ConversationQueryDirectoryResultSchema = z
  .object({
    // rowId 升序。
    entries: z.array(conversationQueryDirectoryEntrySchema),
    // afterRowId 方向是否还有更多 query 条目。
    hasMore: z.boolean(),
    // 服务端取值时的水位/纪元；与 rows/range 等只读查询共用，避免跨 revision 拼接发布数据。
    atSeq: z.number(),
    atRevision: z.number().int().nonnegative(),
    atLogEpoch: z.string(),
  })
  .strict();
export type V4ConversationQueryDirectoryResult = z.infer<
  typeof v4ConversationQueryDirectoryResultSchema
>;

/** CLI 侧目录条目的行内构建输入：裁决已完成的最小 render 粒度。 */
export interface ConversationQueryDirectoryUnitInput {
  key: string;
  turnId: string;
  /** 本轮可见 user 输入（含系统来源，由构建函数按 origin 再裁决）。 */
  userInputs: readonly {
    rowId: number;
    entityId?: string;
    text: string;
    origin: string;
  }[];
  /** 本轮全部 assistant 正文段（已按 CLI 全序聚合，不在目录层猜 guide 分段）。 */
  assistantTexts: readonly string[];
  isRunning: boolean;
  timelineOnly: boolean;
}

export interface BuildConversationQueryDirectoryOptions {
  maxPreviewChars?: number;
  maxPreviewParagraphs?: number;
}

const QUERY_DIRECTORY_DEFAULT_MAX_PREVIEW_CHARS = 220;
const QUERY_DIRECTORY_DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;

function normalizeDirectoryPreviewParagraphs(text: string, maxParagraphs: number): string[] {
  return text
    .trim()
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxParagraphs));
}

function truncateDirectoryPreview(text: string, maxChars: number): string {
  const normalizedMaxChars = Math.max(8, maxChars);
  if (text.length <= normalizedMaxChars) {
    return text;
  }
  return `${text.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
}

function buildDirectoryPreviewText(
  texts: readonly string[],
  maxChars: number,
  maxParagraphs: number,
): string | null {
  const paragraphs = normalizeDirectoryPreviewParagraphs(texts.join("\n\n"), maxParagraphs);
  if (paragraphs.length === 0) {
    return null;
  }
  return truncateDirectoryPreview(paragraphs.join("\n"), maxChars);
}

/**
 * 按 product turn 聚合行构建目录条目（CLI 侧纯函数，可单测）。
 *
 * 产品语义与 renderer 旧实现逐条对齐：
 * - 目录骨架 = origin === "realUser" 的 userInput（background/goal/mailbox
 *   等系统上下文不得入目录）；
 * - 导航粒度 = query（同 turn 多条 steer query 逐条建项，key 用稳定 row 身份）；
 * - assistant 摘要 = 所属 product turn 的全部正文聚合截断，不猜 guide 分段；
 * - 同一 running turn 只有最后一条 query 标 running；
 * - user/assistant 摘要为空时返回空串，由 UI 按 kind 做本地化兜底。
 */
export function buildConversationQueryDirectoryEntries(
  units: readonly ConversationQueryDirectoryUnitInput[],
  options: BuildConversationQueryDirectoryOptions = {},
): ConversationQueryDirectoryEntry[] {
  const maxPreviewChars = options.maxPreviewChars ?? QUERY_DIRECTORY_DEFAULT_MAX_PREVIEW_CHARS;
  const maxPreviewParagraphs =
    options.maxPreviewParagraphs ?? QUERY_DIRECTORY_DEFAULT_MAX_PREVIEW_PARAGRAPHS;
  return units.flatMap((unit) => {
    if (unit.timelineOnly) {
      return [];
    }
    const realUserInputs = unit.userInputs.filter((row) => row.origin === "realUser");
    if (realUserInputs.length === 0) {
      return [];
    }
    const assistantTextPreview = buildDirectoryPreviewText(
      unit.assistantTexts,
      maxPreviewChars,
      maxPreviewParagraphs,
    );
    const assistantPreviewKind: ConversationQueryDirectoryAssistantPreviewKind =
      assistantTextPreview !== null ? "text" : unit.isRunning ? "running" : "empty";
    // 同一 running product turn 可能已有多个已结束 guide segment，running 强调只属于
    // 最后一条 query：kind 对非末条回落为 text/empty，UI 不再对它们做 running 高亮。
    return realUserInputs.map((row, queryIndex) => {
      const isLastQuery = queryIndex === realUserInputs.length - 1;
      const resolvedKind =
        !isLastQuery && assistantPreviewKind === "running" ? "empty" : assistantPreviewKind;
      return {
        key: `${unit.key}:query:${row.entityId ?? row.rowId}`,
        rowId: row.rowId,
        turnId: unit.turnId,
        userPreview:
          buildDirectoryPreviewText([row.text], maxPreviewChars, maxPreviewParagraphs) ?? "",
        assistantPreview: assistantTextPreview ?? "",
        assistantPreviewKind: resolvedKind,
      };
    });
  });
}
