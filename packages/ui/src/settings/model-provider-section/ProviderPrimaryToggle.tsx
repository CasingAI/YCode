import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Switch } from "@/components/ui/switch.js";

export function ProviderPrimaryToggle({
  primary,
  saving = false,
  onCheckedChange,
}: {
  primary: boolean;
  saving?: boolean;
  onCheckedChange: (primary: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "settings.modelProvider.primaryProvider" });
  const hint = intl.formatMessage({ id: "settings.modelProvider.primaryProviderHint" });

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-input-border bg-input px-3 py-2">
      <div className="min-w-0">
        <div className="text-ui-base font-medium text-foreground">{label}</div>
        <div className="truncate text-ui-sm text-foreground-subtle" title={hint}>
          {hint}
        </div>
      </div>
      <ControlHintTooltip standalone title={label}>
        {/* Tooltip 的 data-state 不能覆盖 Switch 的 checked 状态，否则轨道样式会消失。 */}
        <span className="inline-flex shrink-0">
          <Switch
            className="after:-inset-x-1"
            data-testid="model-provider-primary-switch"
            aria-label={label}
            checked={primary}
            disabled={saving}
            onCheckedChange={onCheckedChange}
          />
        </span>
      </ControlHintTooltip>
    </div>
  );
}
