import type { ZCodeConfigOption, ZCodeProvider } from "@zcode/shared";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getConfigOptionEntryLabel } from "@/chat-input-toolbar/display.js";
import {
  normalizeThoughtLevelText,
  thoughtLevelLabelId,
} from "@/chat-input-toolbar/thoughtLevelLabelIds.js";

// 档位值 → 词条 id 的映射表住在 thoughtLevelLabelIds（无依赖叶子模块），这里转出去给既有调用方，
// 免得同一张表出现两个 import 路径。
export { thoughtLevelLabelId };

type ThoughtLevelEntry = NonNullable<ZCodeConfigOption["options"]>[number];

const NO_THOUGHT_LEVEL_VALUES = new Set([
  "disabled",
  "false",
  "no",
  "none",
  "nothink",
  "no-think",
  "no_think",
  "off",
]);

export function isNoThoughtLevel(entry: ThoughtLevelEntry): boolean {
  return NO_THOUGHT_LEVEL_VALUES.has(normalizeThoughtLevelText(entry.value));
}

export function getNextThoughtLevelValue(
  option: Pick<ZCodeConfigOption, "type" | "currentValue" | "options">,
): string | null {
  if (option.type !== "select" || !option.options || option.options.length < 2) {
    return null;
  }

  // 配置已声明档位顺序；名称别名只用于展示，不能改变菜单或快捷键顺序。
  const entries = option.options;
  const currentValue = String(option.currentValue);
  const currentIndex = entries.findIndex((candidate) => candidate.value === currentValue);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % entries.length;

  return entries[nextIndex]?.value ?? null;
}

export function getThoughtLevelLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  provider: ZCodeProvider | undefined,
  option: ZCodeConfigOption,
  entry: ThoughtLevelEntry,
): string {
  const labelId = thoughtLevelLabelId(entry.value);
  if (labelId) {
    return intl.formatMessage({ id: labelId });
  }

  return getConfigOptionEntryLabel(intl, provider, option, entry);
}
