import {
  findGoalCommandTokenStart,
  hasGoalCommandToken,
  sliceGoalCommandArgs,
} from "@zcode/shared";

export type V4VisibleSlashCommand =
  | {
      kind: "compact";
      displayText: string;
      /** 用户跟在 /compact 后面的摘要指令；空串视作无参。 */
      instructions: string;
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

/**
 * 顶格 slash 命令的唯一权威判定（docs/specs/goal-command-scope-and-decoration.md
 * 「位置语义与显示对齐」）。
 *
 * 「什么位置算命令」只有这里一处真源：`parseV4VisibleSlashCommand` 决定执行语义，
 * 面板候选过滤、气泡芯片渲染、编辑器参数作用域着色都读这里。分两档：goal/target
 * 可句中命中；compact/compress/plan/init 只有顶格才算命令。goal 的句中 token 边界在
 * `packages/shared/src/goal-command-token.ts`，同样只此一份。
 */
const TOP_LEVEL_MATCH_RE = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

/** 只有顶格才算命令的内建命令名（小写）。goal/target 走句中扫描，不在此列。 */
const TOP_LEVEL_ONLY_COMMAND_NAMES = new Set(["compact", "compress", "plan", "init"]);

export function normalizeSlashCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

/** 该命令是否只认顶格（句中出现不算命令）。 */
export function isTopLevelOnlySlashCommandName(value: string): boolean {
  return TOP_LEVEL_ONLY_COMMAND_NAMES.has(normalizeSlashCommandName(value));
}

/**
 * 输入中的 `/name` 是否落在顶格：触发符之前只允许空白或行首。
 *
 * 面板触发符（`promptInputTriggers.ts` 的 `ACTIVE_TRIGGER_RE`）用 `(^|\s)` 锚定，
 * 句中也能唤起；这里给显示层与执行层一个一致的收紧判据：句中命中的顶格命令不进
 * 候选、不建芯片、不画气泡芯片。
 */
export function isTopLevelSlashCommandAt(text: string, commandName: string): boolean {
  const match = TOP_LEVEL_MATCH_RE.exec(text.trim());
  return match !== null && normalizeSlashCommandName(match[1] ?? "") === commandName;
}

/**
 * 顶格命令 token 的结束下标（参数正文起点）；该段不是顶格命令则返回 -1。
 *
 * 供编辑器作用域着色切分文本节点用：token 之后的正文即「会作为参数下发的部分」，
 * 装饰范围必须与下发范围完全重合（`/compact 1231231` 的 `1231231` 是真的 instructions）。
 */
export function topLevelSlashCommandTokenEnd(text: string): number {
  const leadingWhitespaceLength = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const match = TOP_LEVEL_MATCH_RE.exec(trimmed);
  if (!match) return -1;
  const name = normalizeSlashCommandName(match[1] ?? "");
  // match[1] 不含前导斜杠，token 本身是 `/name`，所以要补回斜杠那一格。
  if (!TOP_LEVEL_ONLY_COMMAND_NAMES.has(name)) return -1;
  return leadingWhitespaceLength + 1 + (match[1] ?? "").length;
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
  const topLevelMatch = displayText.startsWith("/") ? TOP_LEVEL_MATCH_RE.exec(displayText) : null;
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
      return { kind: "compact", displayText, instructions: args };
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
