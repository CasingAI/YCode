import {
  findGoalCommandTokenStart,
  hasGoalCommandToken,
  sliceGoalCommandArgs,
} from "@zcode/shared";

export type V4VisibleSlashCommand =
  | {
      kind: "compact";
      displayText: string;
    }
  | {
      kind: "planShortcut";
      task: string;
      displayText: string;
    }
  | {
      kind: "unsupportedPlanShortcut";
      task: string;
      displayText: string;
    }
  | {
      kind: "sendGoalCommand";
      objective: string;
      displayText: string;
    }
  | {
      kind: "resumeGoal";
      displayText: string;
    }
  | {
      kind: "emptyGoal";
      displayText: string;
    }
  | {
      kind: "unsupportedGoal";
      action: string;
      displayText: string;
    }
  | {
      kind: "unsupportedGoalAttachments";
      displayText: string;
    };

interface V4VisibleSlashCommandParseOptions {
  contextAttachmentCount?: number;
}

interface SelectionSideSlashCommand {
  command: "side" | "btw";
  text: string;
  displayText: string;
}

interface SelectionSideSlashCommandParseOptions {
  contextAttachmentCount?: number;
  /** CLI catalog 中已经注册的同名命令；同名 CLI 命令优先，不由 App 消费。 */
  enabledCommandNames?: readonly string[];
}

export function parseV4VisibleSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: V4VisibleSlashCommandParseOptions = {},
): V4VisibleSlashCommand | null {
  const displayText = content.trim();
  if (!displayText) return null;

  // 顶格 slash 命令维持既有语义，本次只放宽 goal。`/plan`、`/compact` 与 CLI catalog 里的
  // 其他命令都不参与句中命中；带前文的 `/plan …` 仍按普通文本下发。
  const topLevelMatch = displayText.startsWith("/")
    ? /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(displayText)
    : null;
  if (topLevelMatch) {
    const commandName = topLevelMatch[1]?.toLowerCase() ?? "";
    const args = topLevelMatch[2]?.trim() ?? "";

    if (commandName === "plan") {
      const hasUnsupportedPayload =
        attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0;
      return {
        kind: hasUnsupportedPayload ? "unsupportedPlanShortcut" : "planShortcut",
        task: args,
        displayText,
      };
    }

    if (commandName === "goal" || commandName === "target") {
      return buildGoalCommand(args, displayText, attachments, options);
    }

    if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) {
      return null;
    }

    if (commandName === "compact" || commandName === "compress") {
      return { kind: "compact", displayText };
    }
    return null;
  }

  const tokenStart = findGoalCommandTokenStart(displayText);
  if (tokenStart === -1) return null;
  // 前文丢弃：目标只取 token 之后到末尾的正文。
  const args = sliceGoalCommandArgs(displayText);
  return buildGoalCommand(args, displayText, attachments, options);
}

function buildGoalCommand(
  args: string,
  displayText: string,
  attachments: readonly unknown[],
  options: V4VisibleSlashCommandParseOptions,
): V4VisibleSlashCommand | null {
  // 有附件或上下文时不能 return null：那会让 SessionPane 走 sendText，
  // 气泡仍把 `/goal` 画成命令，自主循环却不会启动。
  if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) {
    return { kind: "unsupportedGoalAttachments", displayText };
  }
  if (!args) return { kind: "emptyGoal", displayText };

  const action = args.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (action === "resume") return { kind: "resumeGoal", displayText };
  if (action === "pause" || action === "clear" || action === "show") {
    return { kind: "unsupportedGoal", action, displayText };
  }
  const objective = action === "replace" ? args.replace(/^replace\s*/i, "").trim() : args;
  if (!objective) return { kind: "emptyGoal", displayText };
  return { kind: "sendGoalCommand", objective, displayText };
}

/**
 * 解析带首条输入的选择副屏命令。
 *
 * 这是 App 层的完整输入消费门：只接受整条文本，且只在没有附件/结构化上下文时
 * 命中。参数只去除首尾空白，保留正文内部的空格和换行，避免改写用户原文。
 */
export function parseSelectionSideSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: SelectionSideSlashCommandParseOptions = {},
): SelectionSideSlashCommand | null {
  if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) return null;
  const displayText = content.trim();
  const match = /^\/(side|btw)(?:\s+([\s\S]*))?$/i.exec(displayText);
  if (!match) return null;
  const command = match[1]?.toLowerCase() as SelectionSideSlashCommand["command"] | undefined;
  const enabledNames = options.enabledCommandNames;
  if (
    enabledNames &&
    !enabledNames.some((name) => name.trim().replace(/^\/+/, "").toLowerCase() === command)
  ) {
    return null;
  }
  const text = match[2]?.trim() ?? "";
  if (!text || !command) return null;
  return { command, text, displayText };
}

export function v4QueuedCommandText(kind: "sendText" | "sendGoalCommand", text: string): string {
  if (kind !== "sendGoalCommand") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  // 句中 `/goal` 同样算 goal 命令，补前缀会产出 `/goal 前面有话 /goal 目标`，必须先判一次。
  return hasGoalCommandToken(trimmed) ? text : `/goal ${trimmed}`;
}
