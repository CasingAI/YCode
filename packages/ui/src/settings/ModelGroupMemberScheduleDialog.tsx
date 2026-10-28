import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ModelGroupDeprioritizeSchedule } from "@zcode/provider";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import {
  prepareModelGroupScheduleAction,
  type ModelGroupScheduleWindowDraft,
} from "@/settings/modelGroupMemberSelectionSettings.js";

interface ModelGroupMemberScheduleDialogProps {
  open: boolean;
  saving: boolean;
  schedule: ModelGroupDeprioritizeSchedule | undefined;
  onOpenChange(open: boolean): void;
  onSave(
    schedule: ModelGroupDeprioritizeSchedule | undefined,
  ): Promise<"saved" | "changed" | "failed">;
}

type ScheduleWindowDraft = ModelGroupScheduleWindowDraft;

const EMPTY_WINDOW: ScheduleWindowDraft = {
  daysOfWeek: [1],
  startTime: "09:00",
  endTime: "17:00",
};

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function ModelGroupMemberScheduleDialog({
  open,
  saving,
  schedule,
  onOpenChange,
  onSave,
}: ModelGroupMemberScheduleDialogProps) {
  const { intl } = useZCodeIntl();
  const [timeZone, setTimeZone] = useState("");
  const [windows, setWindows] = useState<ScheduleWindowDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTimeZone(schedule?.timeZone ?? browserTimeZone());
    setWindows(
      schedule?.windows.map((window) => ({
        daysOfWeek: [...window.daysOfWeek],
        startTime: window.startTime,
        endTime: window.endTime,
      })) ?? [],
    );
    setError(null);
  }, [open, schedule]);

  const updateWindow = (index: number, patch: Partial<ScheduleWindowDraft>) => {
    setWindows((current) =>
      current.map((window, itemIndex) => (itemIndex === index ? { ...window, ...patch } : window)),
    );
    setError(null);
  };

  const updateEndTime = (index: number, value: string) => {
    updateWindow(index, { endTime: value });
  };

  const toggleEndOfDay = (index: number, enabled: boolean) => {
    updateWindow(index, { endTime: enabled ? "24:00" : "00:00" });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!saving) onOpenChange(nextOpen);
  };

  const handleSave = async () => {
    const preparation = prepareModelGroupScheduleAction("save", timeZone, windows);
    if (preparation.kind === "cancel") return;
    if (preparation.kind === "invalid") {
      setError(
        intl.formatMessage({
          id:
            preparation.error === "equalTimes"
              ? "settings.modelGroups.scheduleEqualTimes"
              : "settings.modelGroups.scheduleInvalid",
        }),
      );
      return;
    }
    const result = await onSave(preparation.data);
    if (result === "saved") onOpenChange(false);
    else {
      setError(
        intl.formatMessage({
          id:
            result === "changed"
              ? "settings.modelGroups.memberChanged"
              : "settings.modelGroups.scheduleSaveFailed",
        }),
      );
    }
  };

  const handleCancel = () => {
    const preparation = prepareModelGroupScheduleAction("cancel", timeZone, windows);
    if (preparation.kind === "cancel") onOpenChange(false);
  };

  const weekdays = [
    { day: 1, id: "settings.modelGroups.weekday.mon" },
    { day: 2, id: "settings.modelGroups.weekday.tue" },
    { day: 3, id: "settings.modelGroups.weekday.wed" },
    { day: 4, id: "settings.modelGroups.weekday.thu" },
    { day: 5, id: "settings.modelGroups.weekday.fri" },
    { day: 6, id: "settings.modelGroups.weekday.sat" },
    { day: 7, id: "settings.modelGroups.weekday.sun" },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {open ? (
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (saving) event.preventDefault();
          }}
          className="max-h-[min(90dvh,48rem)] min-w-0 max-w-[calc(100%-1rem)] overflow-y-auto sm:max-w-xl"
          data-testid="model-group-schedule-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({ id: "settings.modelGroups.scheduleTitle" })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-4">
            <label className="flex min-w-0 flex-col gap-1 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelGroups.timeZone" })}
              <Input
                value={timeZone}
                disabled={saving}
                autoComplete="off"
                aria-label={intl.formatMessage({ id: "settings.modelGroups.timeZone" })}
                onChange={(event) => {
                  setTimeZone(event.target.value);
                  setError(null);
                }}
                className="min-w-0 text-mobile-input-safe md:text-ui-base"
              />
            </label>
            <div className="flex flex-col gap-3">
              {windows.map((window, index) => (
                <fieldset
                  key={index}
                  className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
                >
                  <legend className="px-1 text-ui-sm text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "settings.modelGroups.scheduleWindow" },
                      { index: index + 1 },
                    )}
                  </legend>
                  <div
                    className="flex min-w-0 flex-wrap gap-1"
                    aria-label={intl.formatMessage({ id: "settings.modelGroups.weekdays" })}
                  >
                    {weekdays.map(({ day, id }) => {
                      const selected = window.daysOfWeek.includes(day);
                      return (
                        <Button
                          key={day}
                          type="button"
                          disabled={saving}
                          size="sm"
                          variant={selected ? "secondary" : "outline"}
                          aria-pressed={selected}
                          aria-label={intl.formatMessage({ id })}
                          onClick={() =>
                            updateWindow(index, {
                              daysOfWeek: selected
                                ? window.daysOfWeek.filter((value) => value !== day)
                                : [...window.daysOfWeek, day],
                            })
                          }
                        >
                          {intl.formatMessage({ id })}
                        </Button>
                      );
                    })}
                  </div>
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
                    <label className="flex min-w-0 flex-col gap-1 text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.modelGroups.startTime" })}
                      <Input
                        type="time"
                        value={window.startTime}
                        disabled={saving}
                        aria-label={intl.formatMessage({ id: "settings.modelGroups.startTime" })}
                        onChange={(event) => updateWindow(index, { startTime: event.target.value })}
                        className="min-w-0 px-2 text-mobile-input-safe md:text-ui-base"
                      />
                    </label>
                    <span className="pb-2 text-ui-sm text-foreground-subtle" aria-hidden="true">
                      –
                    </span>
                    <label className="flex min-w-0 flex-col gap-1 text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.modelGroups.endTime" })}
                      <Input
                        type="time"
                        value={window.endTime === "24:00" ? "00:00" : window.endTime}
                        disabled={saving || window.endTime === "24:00"}
                        aria-label={intl.formatMessage({ id: "settings.modelGroups.endTime" })}
                        onChange={(event) => updateEndTime(index, event.target.value)}
                        className="min-w-0 px-2 text-mobile-input-safe md:text-ui-base"
                      />
                      <Button
                        type="button"
                        variant={window.endTime === "24:00" ? "secondary" : "ghost"}
                        size="sm"
                        disabled={saving}
                        aria-pressed={window.endTime === "24:00"}
                        onClick={() => toggleEndOfDay(index, window.endTime !== "24:00")}
                      >
                        {intl.formatMessage({ id: "settings.modelGroups.endOfDay" })}
                      </Button>
                    </label>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    className="self-end"
                    aria-label={intl.formatMessage({
                      id: "settings.modelGroups.removeScheduleWindow",
                    })}
                    onClick={() => {
                      setWindows((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      );
                      setError(null);
                    }}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.modelGroups.removeScheduleWindow" })}
                  </Button>
                </fieldset>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              className="self-start"
              onClick={() =>
                setWindows((current) => [
                  ...current,
                  { ...EMPTY_WINDOW, daysOfWeek: [...EMPTY_WINDOW.daysOfWeek] },
                ])
              }
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.modelGroups.addScheduleWindow" })}
            </Button>
            {error ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={handleCancel}>
              {intl.formatMessage({ id: "settings.modelGroups.cancel" })}
            </Button>
            <Button type="button" disabled={saving} onClick={() => void handleSave()}>
              {intl.formatMessage({ id: "settings.modelGroups.save" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
