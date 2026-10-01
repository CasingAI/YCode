import type { MentionCategory, MentionItemData } from "@/mentions/mentionTypes.js";
import type { PromptMentionPayloadShorthand } from "@/mentions/mentionRestoreTypes.js";

/**
 * canonical 链接 → mention 节点载荷的还原。
 *
 * 发送时 `$getPromptMarkdown` 对每个 `PromptMentionNode` 直接输出构造时存下的
 * `__markdown`（`PromptMentionNode.getMarkdown`），形态由各 `build*MentionMarkdown`
 * 决定；行内编辑恢复时要把这些链接还原成节点，否则编辑框显示裸 `[...](...)` 原文。
 *
 * 只还原链接形式。裸 token（`/cmd`、`@name`、`#sess_xxx`、`$name`）无法区分
 * “用户真敲的”与“mention 序列化产物”，一律保持纯文本，不在此处理。
 *
 * `markdown` 取 match 全文原样回填 `__markdown`：重发时 `$getPromptMarkdown` 输出
 * 逐字一致，编辑往返无损。
 */

const LINK_PATTERN = /\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)/g;

const PLUGIN_STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SESSION_DESTINATION_PATTERN = /^#(sess_[a-zA-Z0-9._-]+)$/;

function unescapeMarkdownText(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      result += text[index + 1];
      index += 1;
      continue;
    }
    result += text[index];
  }
  return result;
}

export interface RestoredMentionLink {
  /** match 全文原文，回填节点 `__markdown` 用。 */
  markdown: string;
  /** 转义还原后的链接文本（如 `$control-browser`、`#Skill xxx`）。 */
  label: string;
  /** 链接目标原文。 */
  destination: string;
}

export interface RestoredMentionPayload extends PromptMentionPayloadShorthand {
  category: MentionCategory;
}

function parsePluginStableId(destination: string): string | undefined {
  if (!destination.startsWith("plugin://")) return undefined;
  const candidate = destination.slice("plugin://".length);
  return candidate.length > 0 && candidate.length <= 256 && PLUGIN_STABLE_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

function toDirectoryPayload(
  label: string,
  destination: string,
  markdown: string,
): RestoredMentionPayload {
  return {
    id: `file:${destination}`,
    category: "files",
    label,
    value: destination,
    markdown,
    data: { kind: "directory", relativePath: destination } satisfies MentionItemData,
  };
}

function toFilePayload(
  label: string,
  destination: string,
  markdown: string,
): RestoredMentionPayload {
  return {
    id: `file:${destination}`,
    category: "files",
    label,
    value: destination,
    markdown,
    data: { kind: "file", relativePath: destination } satisfies MentionItemData,
  };
}

/**
 * 单条 canonical 链接映射成 mention 节点载荷。无法映射（普通 markdown 链接、
 * 非法 plugin id）时返回 null，调用方保持纯文本。
 *
 * 映射口径与各 provider 的 `MentionItem` 构造对齐：
 * - skills：`skillsMentionProvider` 用 `id: skill:${skill.id}`，`value` 为技能名，
 *   `data.path` 为 skill 路径。持久文本里只有路径没有服务端 id，id 取确定性合成
 *   `skill:${value}`——id 只用于编辑器内光标定位（`selectAfterPromptMentionById`），
 *   不参与发送，发送只读 `__markdown`。
 * - sessions：`sessionsMentionProvider.mapTaskToMentionItem` 用 `id: session:${taskId}`，
 *   `value` 为 sessionId，label 为人类可读标题。destination `#sess_xxx` 即身份。
 * - files：`fileMentionProvider.mapWorkspaceFileToMentionItem` 用 `id: file:${relativePath}`，
 *   `value` 为 relativePath，label 为 basename。
 */
export function restoreMentionLinkPayload(
  link: RestoredMentionLink,
): RestoredMentionPayload | null {
  const { label, destination, markdown } = link;

  const pluginId = parsePluginStableId(destination);
  if (pluginId) {
    // 与 `replaceEditorTextWithPluginMentions` 的映射逐字一致。
    const displayLabel = label.startsWith("@") ? label : `@${label}`;
    return {
      id: `plugin:${pluginId}`,
      category: "plugins",
      label: displayLabel,
      value: pluginId,
      markdown,
      data: { pluginId } satisfies MentionItemData,
    };
  }

  const sessionMatch = SESSION_DESTINATION_PATTERN.exec(destination);
  if (sessionMatch) {
    const sessionId = sessionMatch[1] ?? destination.slice(1);
    if (!sessionId) return null;
    return {
      id: `session:${sessionId}`,
      category: "sessions",
      label,
      value: sessionId,
      markdown,
    };
  }

  if (label.startsWith("$")) {
    const name = label.slice(1).trim();
    if (!name) return null;
    return {
      id: `skill:${name}`,
      category: "skills",
      label,
      value: name,
      markdown,
      data: { path: destination } satisfies MentionItemData,
    };
  }

  // 目录 mention 的 destination 以斜杠结尾（`buildFileMentionMarkdown` 语义）。
  if (/[\\/]$/.test(destination)) {
    return toDirectoryPayload(label, destination, markdown);
  }

  // 其余一切链接（相对/绝对文件路径、普通 http 链接、用户手写链接）：
  // 与气泡现有语义统一，走文件分支——气泡对同类链接同样显示文件芯片。
  // 纯展示用途的 http(s) 外链除外，保持纯文本，避免编辑框凭空造文件芯片。
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(destination)) return null;
  if (!label.trim() || !destination.trim()) return null;
  return toFilePayload(label, destination, markdown);
}

export interface RestoredMentionSegment {
  /** 纯文本段。 */
  text: string;
}

/**
 * 把一段 canonical markdown 切成“纯文本 / mention 载荷”交替序列。
 * 非链接文本（含裸 token）原样作为 text 段返回，不做任何 token 还原。
 */
export function splitMentionLinks(
  segment: string,
): Array<RestoredMentionSegment | { payload: RestoredMentionPayload }> {
  const parts: Array<RestoredMentionSegment | { payload: RestoredMentionPayload }> = [];
  LINK_PATTERN.lastIndex = 0;
  let cursor = 0;
  for (const match of segment.matchAll(LINK_PATTERN)) {
    const fullMatch = match[0] ?? "";
    const rawLabel = match[1] ?? "";
    const destination = match[2] ?? match[3] ?? "";
    const matchStart = match.index ?? 0;
    if (matchStart > cursor) {
      parts.push({ text: segment.slice(cursor, matchStart) });
    }
    const payload = restoreMentionLinkPayload({
      markdown: fullMatch,
      label: unescapeMarkdownText(rawLabel),
      destination,
    });
    if (payload) {
      parts.push({ payload });
    } else {
      parts.push({ text: fullMatch });
    }
    cursor = matchStart + fullMatch.length;
  }
  if (cursor < segment.length) {
    parts.push({ text: segment.slice(cursor) });
  }
  return parts;
}
