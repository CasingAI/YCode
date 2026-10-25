/**
 * 设置页「数据与统计 › 存储 › 存储选项」面板。
 * 这里只承载与存储相关的用户开关：会话产物占用提示、模型调用轨迹记录、会话产物自动清理。
 * 真值统一在宿主设置服务 AppSettings，本面板不另建持久化，也不做跨端同步。
 */
import { Switch } from "@/components/ui/switch.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isSessionStorageWarningEnabled } from "@/v4/sessionStorageWarningModel.js";

export function StorageOptionsPanel() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const modelIoRecordingEnabled = settings?.modelIoRecordingEnabled !== false;
  const autoCleanupEnabled =
    settings?.sessionArtifactAutoCleanupEnabled === true;
  const sessionStorageWarningEnabled = isSessionStorageWarningEnabled(settings);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.storage.sessionStorageWarning" })}
          </div>
          <div className="mt-0.5 text-ui-caption text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.storage.sessionStorageWarningDescription",
            })}
          </div>
        </div>
        <Switch
          checked={sessionStorageWarningEnabled}
          disabled={!settings}
          onCheckedChange={(enabled) => {
            void update({ sessionStorageWarningEnabled: enabled });
          }}
          aria-label={intl.formatMessage({
            id: "settings.storage.sessionStorageWarning",
          })}
        />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.storage.modelIoRecording" })}
          </div>
          <div className="mt-0.5 text-ui-caption text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.storage.modelIoRecordingDescription",
            })}
          </div>
        </div>
        <Switch
          checked={modelIoRecordingEnabled}
          disabled={!settings}
          onCheckedChange={(enabled) => {
            void update({ modelIoRecordingEnabled: enabled });
          }}
          aria-label={intl.formatMessage({
            id: "settings.storage.modelIoRecording",
          })}
        />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.storage.autoCleanup" })}
          </div>
          <div className="mt-0.5 text-ui-caption text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.storage.autoCleanupDescription",
            })}
          </div>
        </div>
        <Switch
          checked={autoCleanupEnabled}
          disabled={!settings}
          onCheckedChange={(enabled) => {
            void update({ sessionArtifactAutoCleanupEnabled: enabled });
          }}
          aria-label={intl.formatMessage({
            id: "settings.storage.autoCleanup",
          })}
        />
      </div>
    </div>
  );
}
