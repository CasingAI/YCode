import { useMemo, useState } from "react";
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
import { BOT_CREATE_PRESETS } from "@/bots/botPresets.js";
import { BOT_NONE_WORKSPACE, type BotWorkspaceOption } from "@/bots/botRosterTypes.js";
import { useBotRosterStore } from "@/bots/botRosterStore.js";

export function BotCreateDialog({
  open,
  onOpenChange,
  workspaceOptions,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceOptions: BotWorkspaceOption[];
  onCreated: (botId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const createBot = useBotRosterStore((state) => state.createBot);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🤖");
  const [background, setBackground] = useState("");
  const [workspaceKey, setWorkspaceKey] = useState(BOT_NONE_WORKSPACE);
  const [emojiOpen, setEmojiOpen] = useState(false);

  const options = useMemo(() => {
    return [
      { key: BOT_NONE_WORKSPACE, label: intl.formatMessage({ id: "bots.workspace.none" }) },
      ...workspaceOptions.filter((option) => option.key !== BOT_NONE_WORKSPACE),
    ];
  }, [intl, workspaceOptions]);

  const reset = () => {
    setName("");
    setEmoji("🤖");
    setBackground("");
    setWorkspaceKey(BOT_NONE_WORKSPACE);
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || !background.trim()) {
      return;
    }
    const id = createBot({
      name: trimmed,
      emoji,
      background: background.trim(),
      workspaceKey,
    });
    reset();
    onCreated(id);
    onOpenChange(false);
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            reset();
          }
          onOpenChange(next);
        }}
      >
        <DialogContent className="sm:max-w-md" data-testid="bot-create-dialog">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage({ id: "bots.create.title" })}</DialogTitle>
            <DialogDescription className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bots.create.description" })}
            </DialogDescription>
            <DialogDescription className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bots.create.description" })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <button
                type="button"
                className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ui-lg transition-transform hover:scale-105"
                aria-label={intl.formatMessage({ id: "bots.field.emoji" })}
                onClick={() => setEmojiOpen(true)}
              >
                {emoji || <SmilePlus className="size-4" />}
              </button>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={intl.formatMessage({ id: "bots.field.name" })}
                aria-label={intl.formatMessage({ id: "bots.field.name" })}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {BOT_CREATE_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEmoji(preset.emoji);
                    setName(intl.formatMessage({ id: `bots.preset.${preset.id}.name` }));
                    setBackground(intl.formatMessage({ id: `bots.preset.${preset.id}.background` }));
                  }}
                >
                  {preset.emoji} {intl.formatMessage({ id: `bots.preset.${preset.id}.name` })}
                </Button>
              ))}
            </div>
            <Textarea
              value={background}
              onChange={(event) => setBackground(event.target.value)}
              placeholder={intl.formatMessage({ id: "bots.field.background" })}
              aria-label={intl.formatMessage({ id: "bots.field.background" })}
              className="min-h-24"
            />
            <label className="flex flex-col gap-1 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bots.field.workspace" })}
              <select
                className="h-8 rounded-md border border-input-border bg-input px-2 text-ui-base text-foreground"
                value={workspaceKey}
                onChange={(event) => setWorkspaceKey(event.target.value)}
              >
                {options.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button type="button" onClick={submit} disabled={!name.trim() || !background.trim()}>
              {intl.formatMessage({ id: "bots.create.submit" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <EmojiPickerDialog
        open={emojiOpen}
        onOpenChange={setEmojiOpen}
        onSelect={(next) => {
          setEmoji(next);
          setEmojiOpen(false);
        }}
      />
    </>
  );
}
