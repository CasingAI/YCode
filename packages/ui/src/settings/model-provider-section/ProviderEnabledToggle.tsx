import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Switch } from "@/components/ui/switch.js";

export function ProviderEnabledToggle({
  enabled,
  saving = false,
  onCheckedChange,
}: {
  enabled: boolean;
  saving?: boolean;
  onCheckedChange: (enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({
    id: enabled
      ? "settings.modelProvider.disableProvider"
      : "settings.modelProvider.enableProvider",
  });

  return (
    <ControlHintTooltip standalone title={label}>
      {/* Tooltip 的 data-state 不能覆盖 Switch 的 checked 状态，否则轨道样式会消失。 */}
      <span className="inline-flex">
        <Switch
          // 共享开关左右各扩展 12px，会覆盖相邻菜单；本标题栏仅保留 4px 横向热区。
          className="after:-inset-x-1"
          data-testid="model-provider-enabled-switch"
          aria-label={label}
          checked={enabled}
          disabled={saving}
          onCheckedChange={onCheckedChange}
        />
      </span>
    </ControlHintTooltip>
  );
}
