import type { SwitchableCommandCenterMode } from "./types.js";

const SWITCHABLE_COMMAND_CENTER_MODES = [
  "plan",
  "readonly",
  "yolo",
] as const satisfies readonly SwitchableCommandCenterMode[];

/** 显示名与内部值解耦（readonly→Ask、yolo→Agent），与注入给模型的 <mode> 标签同词。 */
const COMMAND_CENTER_MODE_LABELS: Record<SwitchableCommandCenterMode, string> = {
  plan: "Plan",
  readonly: "Ask",
  yolo: "Agent",
};

export function formatCommandCenterModeLabel(mode: string): string {
  return COMMAND_CENTER_MODE_LABELS[mode as SwitchableCommandCenterMode] ?? mode;
}

export function formatAvailableCommandCenterModes(): string {
  return SWITCHABLE_COMMAND_CENTER_MODES.map(formatCommandCenterModeLabel).join(", ");
}

export function isSwitchableCommandCenterMode(
  value: string,
): value is SwitchableCommandCenterMode {
  return SWITCHABLE_COMMAND_CENTER_MODES.includes(value as SwitchableCommandCenterMode);
}
