import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  DEFAULT_SOUND_EVENT_SELECTIONS,
  SOUND_EVENT_STATUSES,
  SYSTEM_SOUND_CUES,
  SYSTEM_SOUND_PACKS,
  formatSystemSoundCueName,
  type SoundEventStatus,
  type SystemSoundCue,
  type SystemSoundPack,
  type SystemSoundSelection,
} from "@/lib/systemSoundCatalog.js";
import { previewSystemSound } from "@/lib/taskNotificationSound.js";
import type { SystemSoundMap } from "@/lib/taskNotificationPreferences.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { createHoverPreviewScheduler } from "@/settings/soundHoverPreview.js";

function soundEventTitleId(status: SoundEventStatus): string {
  switch (status) {
    case "completed":
      return "settings.sounds.event.completed";
    case "failed":
      return "settings.sounds.event.failed";
    case "permission_request":
      return "settings.sounds.event.permissionRequest";
    case "elicitation_request":
      return "settings.sounds.event.elicitationRequest";
  }
}

// 8 个常用音保留专属文案，其余 70 个显示处理后的英文原名（中英同一文案）。
function soundCueLabelId(cue: SystemSoundCue): string | null {
  switch (cue) {
    case "complete":
      return "settings.sounds.cue.complete";
    case "success":
      return "settings.sounds.cue.success";
    case "error":
      return "settings.sounds.cue.error";
    case "warning":
      return "settings.sounds.cue.warning";
    case "notification":
      return "settings.sounds.cue.notification";
    case "mention":
      return "settings.sounds.cue.mention";
    case "info":
      return "settings.sounds.cue.info";
    case "receive":
      return "settings.sounds.cue.receive";
    default:
      return null;
  }
}

function SoundCueLabel({ cue }: { cue: SystemSoundCue }): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const labelId = soundCueLabelId(cue);
  if (labelId) {
    return <>{intl.formatMessage({ id: labelId })}</>;
  }
  return <>{formatSystemSoundCueName(cue)}</>;
}

function SoundSelectionPicker({
  status,
  selection,
  disabled,
  onSelect,
}: {
  status: SoundEventStatus;
  selection: SystemSoundSelection;
  disabled?: boolean;
  onSelect: (status: SoundEventStatus, selection: SystemSoundSelection) => void;
}): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  // 划过试听节流器：移到某音频项上先记下来，停留约 150ms 没再动才播一次。
  // 只播不存，存储只在真正点选时写，避免路过听一下就改掉当前选择。
  // 用 ref 持有单例，避免每次渲染重建导致 timer 丢失。
  const hoverSchedulerRef = useRef<ReturnType<typeof createHoverPreviewScheduler> | null>(null);
  if (hoverSchedulerRef.current === null) {
    hoverSchedulerRef.current = createHoverPreviewScheduler((pack, cue) => {
      // 复用点选试听同一入口：穿透总开关，关着通知也能听。
      void previewSystemSound(pack, cue);
    });
  }

  const clearHoverPreview = () => {
    hoverSchedulerRef.current?.cancel();
  };

  useEffect(() => {
    // 关菜单或卸载时清掉 pending，保证不播出野声。
    if (!open) {
      clearHoverPreview();
    }
    return clearHoverPreview;
  }, [open ]);

  const scheduleHoverPreview = (pack: SystemSoundPack, cue: SystemSoundCue) => {
    hoverSchedulerRef.current?.schedule(pack, cue);
  };

  const handleSelect = (pack: SystemSoundPack, cue: SystemSoundCue) => {
    // 点选是播存一起：回填整对选择再补一声确认。不做去重——
    // 节流播过的那一声和回填播的一声可能连着，去重会引入播存竞态，不值。
    clearHoverPreview();
    onSelect(status, { pack, cue });
    // 选中即试听一次（穿透总开关），不满意重选，不需要额外试听按钮。
    void previewSystemSound(pack, cue);
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disabled}
          className="w-[260px] min-w-0 justify-between"
        >
          <span className="min-w-0 truncate">
            {intl.formatMessage({ id: `settings.sounds.pack.${selection.pack}` })}
            {" · "}
            <SoundCueLabel cue={selection.cue} />
          </span>
          <ChevronDownIcon className="pointer-events-none size-3.5 shrink-0 text-foreground-subtle" />
        </Button>
      </DropdownMenuTrigger>
      {open ? (
        <DropdownMenuContent
          className="w-64"
          align="end"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {SYSTEM_SOUND_PACKS.map((pack) => (
            <DropdownMenuSub key={pack}>
              <DropdownMenuSubTrigger
                className="min-h-8"
                data-sound-pack={pack}
                data-sound-pack-selected={
                  selection.pack === pack ? "true" : undefined
                }
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  {intl.formatMessage({ id: `settings.sounds.pack.${pack}` })}
                </span>
                {selection.pack === pack ? (
                  <CheckIcon className="size-4 text-foreground-subtle" />
                ) : null}
              </DropdownMenuSubTrigger>
              {/* 高度交给二级菜单的可用高度上限（dropdown-menu.tsx），这里只管宽度上限。 */}
              <DropdownMenuSubContent className="w-max min-w-48 max-w-72">
                <DropdownMenuRadioGroup value={`${selection.pack}:${selection.cue}`}>
                  {SYSTEM_SOUND_CUES.map((cue) => (
                    <DropdownMenuRadioItem
                      key={cue}
                      value={`${pack}:${cue}`}
                      className="min-h-8 gap-2 pl-2 pr-8 text-ui-base"
                      onSelect={() => handleSelect(pack, cue)}
                      // 划过即试听：键盘走 focus、鼠标走 pointermove，两路进同一个节流器；
                      // 只播不存，存储只在 onSelect 点选时写。
                      onFocus={() => scheduleHoverPreview(pack, cue)}
                      onPointerMove={() => scheduleHoverPreview(pack, cue)}
                    >
                      <span className="min-w-0 flex-1 truncate text-left">
                        <SoundCueLabel cue={cue} />
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
}

export function SoundsSectionContent({
  notificationEnabled,
  notificationSoundEnabled,
  notificationSoundMap,
  setNotificationEnabled,
  setNotificationSoundEnabled,
  setNotificationSoundForStatus,
}: {
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  notificationSoundMap: SystemSoundMap;
  setNotificationEnabled: (enabled: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  setNotificationSoundForStatus: (
    status: SoundEventStatus,
    selection: SystemSoundSelection,
  ) => void;
}): React.JSX.Element {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.notification" })}
          description={intl.formatMessage({
            id: "settings.notificationDescription",
          })}
          control={
            <Switch checked={notificationEnabled} onCheckedChange={setNotificationEnabled} />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.notificationSound" })}
          description={intl.formatMessage({
            id: "settings.notificationSoundDescription",
          })}
          control={
            <Switch
              checked={notificationSoundEnabled}
              disabled={!notificationEnabled}
              onCheckedChange={setNotificationSoundEnabled}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        {SOUND_EVENT_STATUSES.map((status) => {
          const selection =
            notificationSoundMap[status] ?? DEFAULT_SOUND_EVENT_SELECTIONS[status];
          return (
            <SettingsRow
              key={status}
              label={intl.formatMessage({ id: soundEventTitleId(status) })}
              description={intl.formatMessage({
                id: "settings.sounds.eventDescription",
              })}
              control={
                <SoundSelectionPicker
                  status={status}
                  selection={selection}
                  disabled={!notificationEnabled}
                  onSelect={setNotificationSoundForStatus}
                />
              }
            />
          );
        })}
      </SettingsGroupCard>
    </div>
  );
}
