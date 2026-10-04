/**
 * slashCommandHelpers — 纯函数辅助工具，供 SlashCommandPlugin.tsx 使用
 */
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { LexicalNode } from "lexical";
import type { AgentSummary, Locale, SkillSummary, ZCodeSlashCommand } from "@zcode/shared";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import { $isPromptMentionNode } from "./mentions/nodes/PromptMentionNode.js";
import { isTopLevelOnlySlashCommandName } from "./v4/slashCommands.js";
import { mapSubagentsToMentionItemsForTest } from "@/mentions/providers/subagentsMentionProvider.js";
import { mapSkillsToMentionItemsForTest } from "@/mentions/providers/skillsMentionProvider.js";
import type { PromptInputSuggestionItem } from "./lib/promptInputTriggers.js";

export interface SlashCommandPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 已有 Session 的 id；null/undefined 表示新建草稿，决定 Skill catalog authority。 */
  sessionId?: string | null;
  disabled?: boolean;
  excludedCommandNames?: readonly string[];
  /**
   * App 层本地命令（如 `/side`）。命令目录仍以 CLI catalog 为权威；这里只允许渲染层
   * 追加"选中即执行 UI 行为"的命令，不参与发送，也不写回 CLI 命令列表。
   */
  appCommands?: readonly AppSlashCommand[];
  /**
   * 命令芯片增删通知（命令名；删除后为 null）。供命令绑定模型对草稿着色：
   * 芯片出现时快照进入前的选择并切到绑定默认，删除后复原（docs/specs/command-model-binding.md）。
   */
  onCommandMentionChange?: (commandName: string | null) => void;
}

/** App 层斜杠命令：选中即执行 UI 行为（不插入 mention、不发送）。 */
export interface AppSlashCommand {
  /** 命令值（不含 `/`），如 "side"。 */
  value: string;
  /** 本地化描述，直接展示在 `/` 面板。 */
  description: string;
  /** 额外搜索关键词；应同时包含中英文别名，保证两种输入习惯都能搜到。 */
  keywords?: readonly string[];
  /** 选中命令后立即执行的 UI 行为。 */
  run: () => void;
}

const APP_SLASH_SUGGESTION_ID_PREFIX = "app-slash:";
/** CLI catalog 命令候选的 id 前缀，与 `buildSlashSuggestions` 拼的 id 对齐。 */
const SLASH_SUGGESTION_ID_PREFIX = "slash:";

export function buildAppSlashCommandSuggestions(
  commands: readonly AppSlashCommand[],
): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.value);
    if (!value) {
      return [];
    }
    return [
      {
        id: `${APP_SLASH_SUGGESTION_ID_PREFIX}${value}`,
        trigger: "/",
        value,
        label: `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.description, ...(command.keywords ?? [])])],
      },
    ];
  });
}

export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(APP_SLASH_SUGGESTION_ID_PREFIX);
}

/**
 * `/side` 门禁：草稿态没有父 session 可挂 child，辅助对话自身不允许再开辅助对话，
 * 只读与手机 viewport 与固定入口保持一致地隐藏。
 */
export function shouldOfferSideSlashCommand(options: {
  isDraft: boolean;
  selectionSideChat: boolean;
  readOnly: boolean;
  isMobileViewport: boolean;
}): boolean {
  return (
    !options.isDraft && !options.selectionSideChat && !options.readOnly && !options.isMobileViewport
  );
}

export function normalizeSlashCommandValue(name: string): string {
  // ZCode Agent 在远端可能直接返回 "/init" 作为命令名。
  // UI 的 value 需要去掉前导斜杠，否则插入 markdown 时会变成 "//init"，并影响 / 面板匹配。
  return name.trim().replace(/^\/+/, "");
}

export function buildSlashSuggestions(commands: ZCodeSlashCommand[]): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.name);
    // UI 曾同时维护内建白名单、GLM `/goal` fallback 和 v4 追加目录，
    // CLI catalog 丢失时仍会显示部分命令，掩盖 `/init` 与自定义命令缺失。命令发现
    // 统一以 CLI protocol catalog 为权威，UI 不再追加命令或维护内建白名单。
    if (!value) {
      return [];
    }
    return [
      {
        id: `slash:${value}`,
        trigger: "/",
        value,
        label: command.inputHint?.trim() || `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.name, command.description, command.inputHint ?? ""])],
      },
    ];
  });
}

/**
 * `/` 面板里的命令候选。`slash:` 是 CLI catalog 命令（插入 mention 芯片），
 * `app-slash:` 是「选中即执行」的 App 命令（不进正文），skills / subagents 是 mention 载荷。
 * 三者在同一个 trigger 下并存，只挡前两者中的芯片类才符合「一条输入一个命令」的语义。
 */
export function isSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(SLASH_SUGGESTION_ID_PREFIX);
}

/**
 * 节点之前（含所在段落内 token 之前）是否已有非空白正文。
 *
 * 顶格判定必须看整篇输入而不是只看光标所在段落：第二段开头的 `/compact` 前面已经有
 * 正文，发送端 `parseV4VisibleSlashCommand` 同样不会把它当命令。
 */
function $hasContentBeforeNode(node: LexicalNode): boolean {
  for (let sibling = node.getPreviousSibling(); sibling; sibling = sibling.getPreviousSibling()) {
    if (sibling.getTextContent().trim() !== "") {
      return true;
    }
  }

  for (let parent = node.getParent(); parent; parent = parent.getParent()) {
    for (
      let sibling = parent.getPreviousSibling();
      sibling;
      sibling = sibling.getPreviousSibling()
    ) {
      if (sibling.getTextContent().trim() !== "") {
        return true;
      }
    }
  }

  return false;
}

/** 该节点是否顶格（整条输入的第一个内容节点）。只能在 Lexical 读事务里调用。 */
export function $isNodeAtTopLevel(node: LexicalNode): boolean {
  return !$hasContentBeforeNode(node);
}

/** 当前 `/` 触发符是否顶格（整条输入的第一个 token）。只能在 Lexical 读事务里调用。 */
export function $isTopLevelSlashTriggerAt(node: LexicalNode, tokenStart: number): boolean {
  if (node.getTextContent().slice(0, tokenStart).trim() !== "") {
    return false;
  }
  return $isNodeAtTopLevel(node);
}

/**
 * 该节点是否是一枚「已错位」的顶格命令芯片：名字在 compact/compress/plan/init 里，
 * 但它前面已经有正文。
 *
 * 插入时刻的位置门控只在敲完 `/compact` 的那一瞬间跑；芯片一旦落进树里就是普通节点，
 * 用户回到行首补一句字、粘贴一段带前文的内容，都会把它挪到句中，而没有任何监听回头复核。
 * 结果是显示承诺命令、发送端按纯文本处理。持续降级与作用域着色都读这份判定，
 * 三处不各写一份位置规则。
 *
 * 判定看整篇输入而非仅本段：第二段开头的 `/compact` 前面同样已有正文，发送端
 * `parseV4VisibleSlashCommand` 也只认整串顶格。goal/target 不在顶格集合里，句中命中
 * 本来就是命令，永远不会被判成错位。只能在 Lexical 读事务里调用。
 */
export function $isMisplacedTopLevelCommandMention(node: LexicalNode): boolean {
  if (!$isPromptMentionNode(node)) return false;
  const { category, value } = node.getMention();
  if (category !== "commands") return false;
  if (!isTopLevelOnlySlashCommandName(value)) return false;
  return $hasContentBeforeNode(node);
}

/**
 * 一条输入只允许一个命令：已经有命令芯片时不再提供命令候选，`/` 面板只剩 skills /
 * subagents（它们是 mention 载荷，不是可执行命令）。
 *
 * 拦在这里而不是发送时，是因为命令之后的全部正文会整体归为该命令的参数：第二个命令
 * 插进来既不会执行也不会被拒绝，只会静默变成参数文本。
 *
 * 第二道门是位置语义：`/compact`、`/plan`、`/init` 只在顶格才是命令。句中仍然弹出候选
 * 等于再次让面板承诺系统不兑现的事——选中只会得到一句永远不会被执行的纯文本。
 * skills / subagents 不受影响，它们本就是 mention 载荷，不参与位置语义。
 */
export function filterCommandSuggestions(
  suggestions: PromptInputSuggestionItem[],
  hasCommandMention: boolean,
  isTopLevelTrigger: boolean,
): PromptInputSuggestionItem[] {
  if (hasCommandMention) {
    return [];
  }
  if (isTopLevelTrigger) {
    return suggestions;
  }
  return suggestions.filter((item) => !isTopLevelOnlySlashCommandName(item.value));
}

export function buildSubagentSuggestions(
  agents: Array<
    Pick<
      AgentSummary,
      "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
    >
  >,
): PromptInputSuggestionItem[] {
  return mapSubagentsToMentionItemsForTest(agents).map((item) =>
    mapSubagentMentionItemToSuggestion(item),
  );
}

export function buildSkillSuggestions(
  skills: Array<
    Pick<SkillSummary, "id" | "name" | "description" | "path" | "scope" | "pluginName">
  >,
  locale?: Locale,
): PromptInputSuggestionItem[] {
  return mapSkillsToMentionItemsForTest(skills, locale).map((item) => ({
    id: item.id,
    trigger: "/",
    value: item.value,
    label: `$${item.value}`,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "skill", "skills", item.value])],
    data: item.data,
  }));
}

function mapSubagentMentionItemToSuggestion(item: MentionItem): PromptInputSuggestionItem {
  return {
    id: item.id,
    trigger: "/",
    value: item.value,
    label: item.label,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "subagent", "agent"])],
    data: item.data,
  };
}

export function getTextAroundCursor() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return {
      textAfterCursor: "",
      textBeforeCursor: $getRoot().getTextContent(),
    };
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const textContent = node.getTextContent();
  return {
    textAfterCursor: textContent.slice(anchor.offset),
    textBeforeCursor: textContent.slice(0, anchor.offset),
  };
}
