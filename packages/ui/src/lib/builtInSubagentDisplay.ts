import type { BuiltInSubagentName } from "@zcode/shared";

/**
 * 三个内置子智能体的英文身份（`BuiltInSubagentName`）到展示文案 messageId 的唯一映射。
 * 身份永远是英文，翻译只发生在展示层；新增内置类型时只改这里，不允许调用处再写名字分支。
 */
export const BUILT_IN_SUBAGENT_SETTINGS_TITLE_IDS: Record<BuiltInSubagentName, string> = {
  "general-purpose": "settings.subagents.builtIn.generalPurpose",
  Explore: "settings.subagents.builtIn.explore",
  Worker: "settings.subagents.builtIn.worker",
};

export const BUILT_IN_SUBAGENT_SIDE_PANE_TYPE_IDS: Record<BuiltInSubagentName, string> = {
  "general-purpose": "sidePane.subagent.generalPurpose",
  Explore: "sidePane.subagent.explore",
  Worker: "sidePane.subagent.worker",
};

/** 两处展示面各自按 locale 准备好的「内置名 → 显示文本」。 */
export type BuiltInSubagentTypeTexts = Record<BuiltInSubagentName, string>;

const BUILT_IN_SUBAGENT_NAME_SET: ReadonlySet<string> = new Set<string>([
  "general-purpose",
  "Explore",
  "Worker",
]);

export function isBuiltInSubagentName(value: string): value is BuiltInSubagentName {
  return BUILT_IN_SUBAGENT_NAME_SET.has(value);
}

/** 按同一张映射取展示文本；调用方负责按各自上下文准备中英文文本，分支逻辑只收敛在这里。 */
export function resolveBuiltInSubagentText(
  name: BuiltInSubagentName,
  texts: BuiltInSubagentTypeTexts,
): string {
  return texts[name];
}
