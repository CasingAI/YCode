import type { BuiltInSubagentName } from "@zcode/shared";

/**
 * 两个内置子智能体的英文身份（`BuiltInSubagentName`）到展示文案 messageId 的唯一映射。
 * 身份永远是英文，翻译只发生在展示层；新增内置类型时只改这里，不允许调用处再写名字分支。
 * Worker（SmartWorker）已废弃（docs/specs/team-mode.md）：历史记录不再走内置映射，原样显示。
 */
export const BUILT_IN_SUBAGENT_SETTINGS_TITLE_IDS: Record<BuiltInSubagentName, string> = {
  "general-purpose": "settings.subagents.builtIn.generalPurpose",
  Explore: "settings.subagents.builtIn.explore",
};

export const BUILT_IN_SUBAGENT_SIDE_PANE_TYPE_IDS: Record<BuiltInSubagentName, string> = {
  "general-purpose": "sidePane.subagent.generalPurpose",
  Explore: "sidePane.subagent.explore",
};

/** 聊天 Agent 工具卡的类型名标签。 */
const BUILT_IN_SUBAGENT_CHAT_TYPE_IDS: Record<BuiltInSubagentName, string> = {
  "general-purpose": "chat.toolCall.agent.type.generalPurpose",
  Explore: "chat.toolCall.agent.type.explore",
};

/** i18n 条目缺失时的英文回退，与英文界面显示一致。 */
const BUILT_IN_SUBAGENT_ENGLISH_NAMES: Record<BuiltInSubagentName, string> = {
  "general-purpose": "general-purpose",
  Explore: "Explore",
};

/** 各展示面按 locale 准备好的「内置名 → 显示文本」。 */
export type BuiltInSubagentTypeTexts = Record<BuiltInSubagentName, string>;

const BUILT_IN_SUBAGENT_NAME_SET: ReadonlySet<string> = new Set<string>([
  "general-purpose",
  "Explore",
]);

export function isBuiltInSubagentName(value: string): value is BuiltInSubagentName {
  return BUILT_IN_SUBAGENT_NAME_SET.has(value);
}

export function resolveBuiltInSubagentDisplayName(value: string): BuiltInSubagentName | null {
  return isBuiltInSubagentName(value) ? value : null;
}

/** 按同一张映射取展示文本；调用方负责按各自上下文准备中英文文本，分支逻辑只收敛在这里。 */
export function resolveBuiltInSubagentText(
  name: BuiltInSubagentName,
  texts: BuiltInSubagentTypeTexts,
): string {
  return texts[name];
}

/**
 * 聊天 Agent 工具卡的类型名：内置名走 i18n 映射，其它身份原样返回。
 * 只做展示层翻译，颜色查找仍必须用原始身份名（颜色是按英文名 hash 的）。
 */
export function resolveBuiltInSubagentChatTypeLabel(
  value: string,
  translate: (messageId: string, fallback: string) => string,
): string {
  const name = resolveBuiltInSubagentDisplayName(value);
  if (!name) {
    return value;
  }
  return translate(BUILT_IN_SUBAGENT_CHAT_TYPE_IDS[name], BUILT_IN_SUBAGENT_ENGLISH_NAMES[name]);
}
