/**
 * 用户气泡里 goal token 的切分与作用域归属（docs/specs/goal-command-scope-and-decoration.md
 * 「回显边界」与「回显作用域视觉」）。
 *
 * 单独成文件是为了不依赖任何 `@/` 别名与 React，能被测试直接引入；
 * 渲染在 `ConversationUserInputContent.tsx`。
 */

import {
  findGoalCommandTokenEnd,
  findGoalCommandTokenStart,
  hasGoalCommandToken,
} from "@zcode/shared";
import { GOAL_SCOPE_TEXT_STYLE } from "../goalScopeTextStyle.js";
import { parseMentionMarkdown } from "../mentions/mentionMarkdown.js";
import { parseV4VisibleSlashCommand } from "./slashCommands.js";

export interface GoalQueryDisplay {
  /** goal token 之前的正文；发送端会丢弃它，回显要保留用户原文。 */
  leadingText: string;
  commandText: string;
  trailingText: string;
}

/**
 * 与发送端同一套 token 边界切分前文 / 命令 / 目标正文。
 */
export function parseGoalQueryDisplay(text: string): GoalQueryDisplay | undefined {
  const tokenStart = findGoalCommandTokenStart(text);
  if (tokenStart < 0) return undefined;
  const tokenEnd = findGoalCommandTokenEnd(text);
  if (tokenEnd < 0) return undefined;
  // 空白只是边界，从前文拿掉以免芯片前多一截空格；句号、逗号是用户正文，必须留下。
  const prefix = tokenStart > 0 ? text[tokenStart - 1] : "";
  const leadingEnd = prefix && /\s/u.test(prefix) ? tokenStart - 1 : tokenStart;
  return {
    leadingText: text.slice(0, leadingEnd),
    commandText: text.slice(tokenStart, tokenEnd),
    trailingText: text.slice(tokenEnd),
  };
}

/** 与发送端一致的大小写不敏感 goal/target 判定，容忍 mention label 里的手写斜杠前缀。 */
export function isGoalCommandLabel(label: string): boolean {
  const normalized = label.trim().replace(/^\/+/, "").toLowerCase();
  return normalized === "goal" || normalized === "target";
}

/** 气泡回显里 mention part 的最小结构投影：goal 芯片判定只看 type 与 label。 */
export interface GoalEchoPart {
  type: string;
  label?: string;
}

export const GOAL_ECHO_CHIP_STYLE = {
  // 颜色字重写在节点上：气泡外壳带 `text-foreground`，靠继承色会把 chip 染回普通正文。
  // 高亮只有色值与字重，没有下划线——zcode 原版其它命令也不带线。
  color: "var(--color-command-node-foreground)",
  fontWeight: 500,
} as const;

/** 与编辑器 PromptMentionNode 的 `data-mention-id` 对齐，驱动同一套 `::before` 图标。 */
export function goalEchoMentionId(label: string): "slash:goal" | "slash:target" {
  const command = label.trim().replace(/^\/+/, "").toLowerCase();
  return command === "target" ? "slash:target" : "slash:goal";
}

/** 目标正文的高亮直接复用编辑器那份声明：气泡与编辑器必须画出同一种高亮。 */
export const GOAL_ECHO_SCOPE_STYLE = GOAL_SCOPE_TEXT_STYLE;

export interface GoalEchoScope {
  /** 权威 goal 芯片在 `parseMentionMarkdown` parts 里的下标。 */
  commandPartIndex: number;
}

/**
 * 定位用户气泡里应画作用域的权威 goal 芯片。
 *
 * 通用 mention 分词仍只认 ASCII 空白。面板选中的 `/goal` 紧贴 `。` 时，持久化文本
 * 里没有空格，气泡会把整段当成纯文本。发送端已经认成 goal 时，这里补一枚芯片，
 * 避免「编辑器有图标、发出去变成 /goal 原文」。
 */
export function materializeGoalEchoParts(text: string): ReturnType<typeof parseMentionMarkdown> {
  const parts = parseMentionMarkdown(text);
  if (parts.some((part) => part.type === "command" && isGoalCommandLabel(part.label))) {
    return parts;
  }
  // 链接目标里的 `/goal` 已被吃成 file part，不能再按原文补芯片。
  const hasTokenInTextPart = parts.some(
    (part) => part.type === "text" && hasGoalCommandToken(part.text),
  );
  if (!hasTokenInTextPart) return parts;
  const display = parseGoalQueryDisplay(text);
  if (!display) return parts;
  return [
    ...parseMentionMarkdown(display.leadingText),
    { type: "command", label: display.commandText.replace(/^\/+/, "") },
    ...parseMentionMarkdown(display.trailingText),
  ];
}

/**
 * 定位用户气泡里应画作用域的权威 goal 芯片。
 *
 * `parseV4VisibleSlashCommand` 是唯一权威：附件门禁、`/compact`、或本就不是 goal 时
 * 返回 null，整条不画作用域。调用方必须先走 `materializeGoalEchoParts`，否则句号紧贴
 * 的 `/goal` 没有 command part，这里会找不到锚点。
 */
export function resolveGoalEchoScope(
  text: string,
  parts: readonly GoalEchoPart[],
  attachments: readonly unknown[] = [],
  contextAttachmentCount = 0,
): GoalEchoScope | null {
  const command = parseV4VisibleSlashCommand(text, attachments, {
    contextAttachmentCount,
  });
  if (
    !command ||
    command.kind === "compact" ||
    command.kind === "unsupportedGoalAttachments" ||
    command.kind === "unsupportedPlanShortcut"
  ) {
    return null;
  }

  const commandPartIndex = parts.findIndex(
    (part) => part.type === "command" && isGoalCommandLabel(part.label ?? ""),
  );
  return commandPartIndex >= 0 ? { commandPartIndex } : null;
}
