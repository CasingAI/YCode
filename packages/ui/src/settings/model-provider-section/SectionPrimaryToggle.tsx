import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Switch } from "@/components/ui/switch.js";

/**
 * 模型组整节 Primary 的二元开关（docs/specs/model-group.md）。
 * 供应商级展示层级已三态化为 ProviderDisplayModeSelect（docs/specs/provider-primary.md）；
 * 本组件只服务 ModelGroupsSection 页底开关，label/hint 由调用方显式传入。
 */
export function SectionPrimaryToggle({
  primary,
  saving = false,
  onCheckedChange,
  label,
  hint,
  testId = "model-groups-primary-switch",
}: {
  primary: boolean;
  saving?: boolean;
  onCheckedChange: (primary: boolean) => void;
  label: string;
  hint: string;
  testId?: string;
}) {
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
            data-testid={testId}
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
