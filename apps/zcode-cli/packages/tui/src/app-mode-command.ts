import React from "react";
import type { ModeCommandSelectionState } from "./app-model.js";
import { TUI_SWITCHABLE_MODES, type TuiSwitchableMode } from "./app-mode.js";
import { matchesText } from "./state.js";
import type { TuiModeOption } from "./types.js";

const MODE_COMMAND_NAME = "/mode";
const MODE_COMMAND_WITH_SPACE = `${MODE_COMMAND_NAME} `;

const MODE_DESCRIPTIONS: Record<TuiSwitchableMode, string> = {
  plan: "Inspect the code and present a plan before editing.",
  readonly: "Read-only Q&A: answering and searching are unrestricted; changes are refused.",
  yolo: "Edit and run commands without per-step confirmation.",
};

const TUI_MODE_OPTIONS: readonly TuiModeOption[] = TUI_SWITCHABLE_MODES.map((mode) => ({
  description: MODE_DESCRIPTIONS[mode],
  id: mode,
  label: formatModeLabel(mode),
}));

function modeCommandQuery(draft: string): string | undefined {
  if (draft === MODE_COMMAND_NAME) return "";
  if (draft.startsWith(MODE_COMMAND_WITH_SPACE)) {
    return draft.slice(MODE_COMMAND_WITH_SPACE.length);
  }
  if (draft.startsWith(MODE_COMMAND_NAME) && !/\s/u.test(draft)) {
    const compactQuery = draft.slice(MODE_COMMAND_NAME.length);
    return isCompactModeQuery(compactQuery) ? compactQuery : undefined;
  }
  return undefined;
}

function filterModeOptions(draft: string): readonly TuiModeOption[] {
  const query = modeCommandQuery(draft);
  if (query === undefined) return [];
  return TUI_MODE_OPTIONS.filter((mode) =>
    matchesText(query, [
      mode.id,
      mode.label,
      mode.description,
      `${MODE_COMMAND_WITH_SPACE}${mode.id}`,
    ]),
  );
}

function reconcileModeCommandSelection(draft: string): ModeCommandSelectionState | undefined {
  return modeCommandQuery(draft) !== undefined ? { selectedIndex: 0 } : undefined;
}

function selectedModeOption(
  submittedValue: string,
  modeSelection: ModeCommandSelectionState | undefined,
  modes: readonly TuiModeOption[],
): TuiModeOption | undefined {
  if (!modeSelection || modeCommandQuery(submittedValue) === undefined || modes.length === 0) {
    return undefined;
  }
  return modes[Math.max(0, Math.min(modeSelection.selectedIndex, modes.length - 1))];
}

export function useModeCommandController(draft: string): {
  filteredOptions: readonly TuiModeOption[];
  reconcileDraft: (value: string) => ModeCommandSelectionState | undefined;
  selectedOption: (submittedValue: string) => TuiModeOption | undefined;
  selection: ModeCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<ModeCommandSelectionState | undefined>>;
} {
  const [selection, setSelection] = React.useState<ModeCommandSelectionState | undefined>();
  const filteredOptions = React.useMemo(() => filterModeOptions(draft), [draft]);
  const reconcileDraft = React.useCallback((value: string) => {
    const nextSelection = reconcileModeCommandSelection(value);
    setSelection(nextSelection);
    return nextSelection;
  }, []);
  const selectedOption = React.useCallback(
    (submittedValue: string) => selectedModeOption(submittedValue, selection, filteredOptions),
    [filteredOptions, selection],
  );

  return {
    filteredOptions,
    reconcileDraft,
    selectedOption,
    selection,
    setSelection,
  };
}

/** 显示名与内部值解耦（readonly→Ask、yolo→Agent），与注入给模型的 <mode> 标签同词。 */
function formatModeLabel(mode: TuiSwitchableMode): string {
  if (mode === "plan") return "Plan";
  if (mode === "readonly") return "Ask";
  return "Agent";
}

function isCompactModeQuery(query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  return TUI_MODE_OPTIONS.some(
    (mode) =>
      mode.id.startsWith(normalizedQuery) || mode.label.toLowerCase().startsWith(normalizedQuery),
  );
}
