import { TID_SETTINGS_AUTOMATION_SWITCH, TID_SETTINGS_DYNAMIC_WORKFLOW_SWITCH } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 实验特性分区：默认关闭、按需开启的开关集中在这里。
 *
 * 对话问题导航 rail 已常开（目录走 query/directory 侧信道，不再为目录拉取整段
 * 历史），不再属于实验特性；本分区只保留 Dynamic Workflow 与定时任务。
 */
export function ExperimentalFeaturesSection({
  dynamicWorkflowEnabled,
  onDynamicWorkflowEnabledChange,
  automationEnabled,
  onAutomationEnabledChange,
}: {
  dynamicWorkflowEnabled: boolean;
  onDynamicWorkflowEnabledChange: (enabled: boolean) => Promise<void>;
  automationEnabled: boolean;
  onAutomationEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.dynamicWorkflow" })}
          description={intl.formatMessage({
            id: "settings.dynamicWorkflowDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.dynamicWorkflow",
              })}
              checked={dynamicWorkflowEnabled}
              data-testid={TID_SETTINGS_DYNAMIC_WORKFLOW_SWITCH}
              onCheckedChange={(checked) => {
                void onDynamicWorkflowEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.automation" })}
          description={intl.formatMessage({
            id: "settings.automationDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.automation",
              })}
              checked={automationEnabled}
              data-testid={TID_SETTINGS_AUTOMATION_SWITCH}
              onCheckedChange={(checked) => {
                void onAutomationEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
