import { TID_SETTINGS_CONVERSATION_TURN_NAVIGATOR_SWITCH } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 实验特性分区：默认关闭、按需开启的开关集中在这里。
 *
 * 开关关闭时不只是隐藏 UI，对应的运行时开销也会一并停用——由
 * ConversationTimeline 的 turnNavigatorEnabled 统一门控。
 */
export function ExperimentalFeaturesSection({
  turnNavigatorEnabled,
  onTurnNavigatorEnabledChange,
}: {
  turnNavigatorEnabled: boolean;
  onTurnNavigatorEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.conversationTurnNavigator" })}
          description={intl.formatMessage({
            id: "settings.conversationTurnNavigatorDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.conversationTurnNavigator",
              })}
              checked={turnNavigatorEnabled}
              data-testid={TID_SETTINGS_CONVERSATION_TURN_NAVIGATOR_SWITCH}
              onCheckedChange={(checked) => {
                void onTurnNavigatorEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
