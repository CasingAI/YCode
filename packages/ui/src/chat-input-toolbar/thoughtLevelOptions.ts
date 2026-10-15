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

/**
 * 思考控件 trigger 的形态：
 * - `toolbar`：随容器宽度自适应（窄=灯塔、中=灯塔+档位竖条、宽=灯塔+文字+箭头），主输入框与设置页用；
 * - `levelBar`：任何宽度钉死「灯塔 + 档位竖条」，无文字无箭头，行内编辑卡用
 *   （docs/specs/composer-edit-thought-level-bar.md）。
 */
export type ThoughtTriggerVariant = "toolbar" | "levelBar";

/**
 * hover 提示标题的取舍：disabledReason 永远优先；levelBar 形态没有内联文字，
 * 提示必须直接给档位词；toolbar 形态沿用「文字可见→控件用途文案，不可见→档位词」。
 */
export function resolveThoughtTooltipTitle(args: {
  variant: ThoughtTriggerVariant;
  disabledReason?: string;
  inlineLabelVisible: boolean;
  tooltipTitle: string;
  currentLabel: string;
}): string {
  if (args.disabledReason) {
    return args.disabledReason;
  }
  if (args.variant === "levelBar") {
    return args.currentLabel;
  }
  return args.inlineLabelVisible ? args.tooltipTitle : args.currentLabel;
}
