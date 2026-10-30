import { useMemo } from "react";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildAutomationModeOption,
  resolveAutomationModeValue,
  type AutomationModeValue,
} from "@/settings/automationAgentConfigOptions.js";

/**
 * 自动化表单的 Agent / Team 选择器。复用会话工具栏的 ConfigSelect、档位图标与文案，
 * 但用 important 档位色覆盖 ConfigSelect 对 yolo 的 warning 色：自动化里两档都是
 * 无人值守执行档，颜色只表达身份，不再表达风险高低。
 */
const AUTOMATION_MODE_TRIGGER_TONE_CLASS: Record<AutomationModeValue, string> = {
  yolo: "text-mode-agent! hover:text-mode-agent! aria-expanded:text-mode-agent! [&_svg]:text-mode-agent!",
  team: "text-mode-team! hover:text-mode-team! aria-expanded:text-mode-team! [&_svg]:text-mode-team!",
};

interface AutomationModeSelectProps {
  value: string | null | undefined;
  disabled?: boolean;
  onValueChange: (value: AutomationModeValue) => void;
  triggerClassName?: string;
  labelVisibilityClassName?: string;
  indicatorClassName?: string;
}

export function AutomationModeSelect({
  value,
  disabled,
  onValueChange,
  triggerClassName,
  labelVisibilityClassName = "hidden @sm/composer:inline-flex",
  indicatorClassName = "hidden @sm/composer:block",
}: AutomationModeSelectProps) {
  const { intl } = useZCodeIntl();
  const modeValue = resolveAutomationModeValue(value);
  const option = useMemo(() => buildAutomationModeOption(modeValue), [modeValue]);

  return (
    <ConfigSelect
      option={option}
      onValueChange={(next) => onValueChange(resolveAutomationModeValue(next))}
      disabled={disabled}
      tooltipTitle={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
      triggerSize="sm"
      triggerClassName={cn(triggerClassName, AUTOMATION_MODE_TRIGGER_TONE_CLASS[modeValue])}
      labelVisibilityClassName={labelVisibilityClassName}
      indicatorClassName={indicatorClassName}
      provider={ZCODE_AGENT_PROVIDER}
      restoreFocusSelector={null}
    />
  );
}
