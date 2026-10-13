import { useState } from "react";
import { SmilePlus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { EmojiPickerDialog } from "@/workspace-grouped-tasks/emoji-picker-dialog.js";
import { BOT_NONE_WORKSPACE, type BotRecord, type BotWorkspaceOption } from "@/bots/botRosterTypes.js";
import { useBotRosterStore } from "@/bots/botRosterStore.js";

export function BotSettingsDialog({
  bot,
  open,
  onOpenChange,
  workspaceOptions,
  notesPath,
  onRevealNotes,
}: {
  bot: BotRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceOptions: BotWorkspaceOption[];
  notesPath: string;
  onRevealNotes?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const updateBot = useBotRosterStore((state) => state.updateBot);
  const hideBot = useBotRosterStore((state) => state.hideBot);
  const [emojiOpen, setEmojiOpen] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" data-testid="bot-settings-dialog">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage({ id: "bots.settings.title" })}</DialogTitle>
            <DialogDescription className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bots.settings.description" })}
            </DialogDescription>
            <DialogDescription className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bots.settings.description" })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <button
                type="button"
                className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ui-lg transition-transform hover:scale-105"
                onClick={() => setEmojiOpen(true)}
              >
                {bot.emoji || <SmilePlus className="size-4" />}
              </button>
              <Input
                value={bot.name}
                onChange={(event) => updateBot(bot.id, { name: event.target.value })}
              />
            </div>
            <Textarea
              value={bot.background}
              onChange={(event) => updateBot(bot.id, { background: event.target.value })}
              className="min-h-24"
            />
            <label className="flex flex-col gap-1 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bots.field.workspace" })}
              <select
                className="h-8 rounded-md border border-input-border bg-input px-2 text-ui-base text-foreground"
                value={bot.workspaceKey}
                onChange={(event) => updateBot(bot.id, { workspaceKey: event.target.value })}
              >
                <option value={BOT_NONE_WORKSPACE}>
                  {intl.formatMessage({ id: "bots.workspace.none" })}
                </option>
                {workspaceOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-ui-sm">
              <input
                type="checkbox"
                checked={bot.hideComposerModelPicker}
                onChange={(event) =>
                  updateBot(bot.id, { hideComposerModelPicker: event.target.checked })
                }
              />
              {intl.formatMessage({ id: "bots.settings.hideModelPicker" })}
            </label>
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "bots.settings.notesPath" }, { path: notesPath })}
            </p>
            {onRevealNotes ? (
              <Button type="button" variant="outline" size="sm" onClick={onRevealNotes}>
                {intl.formatMessage({ id: "bots.settings.revealNotes" })}
              </Button>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                hideBot(bot.id);
                onOpenChange(false);
              }}
            >
              {intl.formatMessage({ id: "bots.settings.hide" })}
            </Button>
            <Button type="button" onClick={() => onOpenChange(false)}>
              {intl.formatMessage({ id: "common.close" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <EmojiPickerDialog
        open={emojiOpen}
        onOpenChange={setEmojiOpen}
        onSelect={(emoji) => {
          updateBot(bot.id, { emoji });
          setEmojiOpen(false);
        }}
      />
    </>
  );
}
