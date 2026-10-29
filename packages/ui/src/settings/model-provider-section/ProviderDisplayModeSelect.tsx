import type { ProviderDisplayMode } from "@zcode/provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 供应商「模型展示权重」三态（docs/specs/provider-primary.md），与 @zcode/provider 的 PROVIDER_DISPLAY_MODES 对齐。 */
const PROVIDER_DISPLAY_MODE_LABEL_IDS: Record<ProviderDisplayMode, string> = {
  expanded: "settings.modelProvider.displayWeight.expanded",
  submenu: "settings.modelProvider.displayWeight.submenu",
  other: "settings.modelProvider.displayWeight.other",
};

export const PROVIDER_DISPLAY_MODES: readonly ProviderDisplayMode[] = [
  "expanded",
  "submenu",
  "other",
];

/** Select onValueChange 的窄化守卫：只放行合法三态，onModeChange 收到的必是 ProviderDisplayMode。 */
export function isProviderDisplayMode(value: string): value is ProviderDisplayMode {
  return (PROVIDER_DISPLAY_MODES as readonly string[]).includes(value);
}

export function resolveProviderDisplayModeLabel(
  intl: { formatMessage: (descriptor: { id: string }) => string },
  mode: ProviderDisplayMode,
): string {
  return intl.formatMessage({ id: PROVIDER_DISPLAY_MODE_LABEL_IDS[mode] });
}

/**
 * 供应商卡片里的「模型展示权重」行 + Select：替代原 Primary 二元开关。
 * 行样式与 CliProxyUpstreamProxySelect 完全一致（DESIGN.md：Select trigger 走 input 语义）。
 */
export function ProviderDisplayModeSelect({
  mode,
  saving = false,
  onModeChange,
  label: labelOverride,
  hint: hintOverride,
  testId = "model-provider-display-weight-select",
}: {
  mode: ProviderDisplayMode;
  saving?: boolean;
  onModeChange: (mode: ProviderDisplayMode) => void;
  label?: string;
  hint?: string;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const label = labelOverride ?? intl.formatMessage({ id: "settings.modelProvider.displayWeight" });
  const hint =
    hintOverride ?? intl.formatMessage({ id: "settings.modelProvider.displayWeightHint" });
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-input-border bg-input px-3 py-2">
      <div className="min-w-0">
        <div className="text-ui-base font-medium text-foreground">{label}</div>
        <div className="truncate text-ui-sm text-foreground-subtle" title={hint}>
          {hint}
        </div>
      </div>
      <Select
        value={mode}
        disabled={saving}
        onValueChange={(value) => {
          if (isProviderDisplayMode(value)) onModeChange(value);
        }}
      >
        <SelectTrigger className="w-[11rem] shrink-0" data-testid={testId} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROVIDER_DISPLAY_MODES.map((candidate) => (
            <SelectItem
              key={candidate}
              value={candidate}
              data-testid={`${testId}-item-${candidate}`}
            >
              {resolveProviderDisplayModeLabel(intl, candidate)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
