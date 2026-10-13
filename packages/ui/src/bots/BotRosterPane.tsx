import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BotCreateDialog } from "@/bots/BotCreateDialog.js";
import {
  filterBotsByName,
  listedVisibleBots,
  pinnedVisibleBots,
} from "@/bots/botRosterLogic.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { classifyBotDrop } from "@/bots/botDropIntake.js";
import { useBotRosterStore } from "@/bots/botRosterStore.js";
import type { BotRecord, BotWorkspaceOption } from "@/bots/botRosterTypes.js";

const BOT_DRAG_TYPE = "application/x-zcode-bot-id";

export function BotRosterPane({
  workspaceOptions,
  onNeedCreate,
  createOpen,
  onCreateOpenChange,
  previousViewRestore,
}: {
  workspaceOptions: BotWorkspaceOption[];
  onNeedCreate: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  previousViewRestore?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const snapshot = useBotRosterStore((state) => state);
  const setActiveBot = useBotRosterStore((state) => state.setActiveBot);
  const queueFilesystemDrop = useBotRosterStore((state) => state.queueFilesystemDrop);
  const pinBot = useBotRosterStore((state) => state.pinBot);
  const unpinBot = useBotRosterStore((state) => state.unpinBot);
  const reorderPins = useBotRosterStore((state) => state.reorderPins);
  const reorderList = useBotRosterStore((state) => state.reorderList);
  const [query, setQuery] = useState("");
  const pinned = pinnedVisibleBots(snapshot);
  const listed = useMemo(
    () => filterBotsByName(listedVisibleBots(snapshot), query),
    [query, snapshot],
  );

  const deliverFilesystemDrop = (event: React.DragEvent, botId: string) => {
    const intake = classifyBotDrop({
      files: Array.from(event.dataTransfer.files),
      uriList: event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"),
      getPathForFile: (file) => platform?.getPathForFile?.(file)?.trim() || undefined,
    });
    if (intake.kind === "empty") {
      return false;
    }
    event.stopPropagation();
    setActiveBot(botId);
    queueFilesystemDrop({
      botId,
      folders: intake.kind === "folders" ? intake.paths : [],
      files: intake.kind === "files" ? intake.files : [],
    });
    return true;
  };

  const onDropPin = (event: React.DragEvent, targetId?: string) => {
    event.preventDefault();
    if (targetId && deliverFilesystemDrop(event, targetId)) {
      return;
    }
    const botId = event.dataTransfer.getData(BOT_DRAG_TYPE);
    if (!botId) {
      return;
    }
    if (targetId && snapshot.pinOrder.includes(botId) && snapshot.pinOrder.includes(targetId)) {
      reorderPins(botId, targetId);
      return;
    }
    const result = pinBot(botId);
    if (result === "full") {
      return;
    }
  };

  const onDropList = (event: React.DragEvent, targetId?: string) => {
    event.preventDefault();
    if (targetId && deliverFilesystemDrop(event, targetId)) {
      return;
    }
    const botId = event.dataTransfer.getData(BOT_DRAG_TYPE);
    if (!botId) {
      return;
    }
    if (snapshot.pinOrder.includes(botId)) {
      unpinBot(botId);
    }
    if (targetId && botId !== targetId) {
      reorderList(botId, targetId);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bot-roster-pane">
      <div className="flex items-center gap-2 px-3 py-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({ id: "bots.roster.search" })}
          aria-label={intl.formatMessage({ id: "bots.roster.search" })}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={intl.formatMessage({ id: "bots.create.title" })}
          onClick={() => onCreateOpenChange(true)}
        >
          <Plus />
        </Button>
      </div>
      <div
        className="flex min-h-24 items-center justify-center gap-4 rounded-xl border border-dashed border-border/60 px-3 py-4 transition-colors"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onDropPin(event)}
        data-testid="bot-pin-dock"
      >
        <AnimatePresence initial={false}>
          {pinned.length === 0 ? (
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "bots.roster.pinHint" })}
            </p>
          ) : (
            pinned.map((bot) => (
              <motion.div
                key={bot.id}
                layout
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.8, opacity: 0 }}
                transition={{ type: "spring", stiffness: 380, damping: 28 }}
              >
                <BotAvatarButton
                  bot={bot}
                  size="lg"
                  selected={snapshot.activeBotId === bot.id}
                  onSelect={() => setActiveBot(bot.id)}
                  onDrop={(event) => onDropPin(event, bot.id)}
                />
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onDropList(event)}
      >
        {listed.map((bot) => (
          <motion.div layout key={bot.id}>
            <button
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(BOT_DRAG_TYPE, bot.id);
              }}
              onDrop={(event) => onDropList(event, bot.id)}
              onDragOver={(event) => event.preventDefault()}
              onClick={() => setActiveBot(bot.id)}
              className={cn(
                "mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                snapshot.activeBotId === bot.id ? "bg-card-selected" : "hover:bg-surface-hover",
              )}
            >
              <BotAvatarMark bot={bot} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-sm">{bot.name}</span>
                <span className="block truncate text-ui-xs text-foreground-subtle">
                  {bot.working
                    ? intl.formatMessage({ id: "bots.roster.working" })
                    : (bot.lastPreview ?? intl.formatMessage({ id: "bots.roster.emptyPreview" }))}
                </span>
              </span>
              {bot.unread ? <span className="size-2 shrink-0 rounded-full bg-brand" /> : null}
            </button>
          </motion.div>
        ))}
      </div>
      <BotCreateDialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && onNeedCreate && !useBotRosterStore.getState().bots.some((bot) => !bot.hidden)) {
            previousViewRestore?.();
          }
          onCreateOpenChange(open);
        }}
        workspaceOptions={workspaceOptions}
        onCreated={(botId) => {
          setActiveBot(botId);
          onCreateOpenChange(false);
        }}
      />
    </div>
  );
}

function BotAvatarButton({
  bot,
  size,
  selected,
  onSelect,
  onDrop,
}: {
  bot: BotRecord;
  size: "sm" | "lg";
  selected: boolean;
  onSelect: () => void;
  onDrop: (event: React.DragEvent) => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(BOT_DRAG_TYPE, bot.id);
      }}
      onDrop={onDrop}
      onDragOver={(event) => event.preventDefault()}
      onClick={onSelect}
      className={cn(
        "relative flex items-center justify-center rounded-full border transition-transform hover:scale-105",
        size === "lg" ? "size-14 text-ui-xl" : "size-8 text-ui-base",
        selected ? "border-brand bg-accent" : "border-border bg-surface",
      )}
      aria-label={bot.name}
      title={bot.name}
    >
      <BotAvatarMark bot={bot} size={size} />
    </button>
  );
}

function BotAvatarMark({ bot, size }: { bot: BotRecord; size: "sm" | "lg" }) {
  return (
    <span className="relative inline-flex items-center justify-center">
      <span className={size === "lg" ? "text-ui-xl" : "text-ui-base"}>{bot.emoji}</span>
      {bot.working ? (
        <span className="absolute -bottom-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-brand" />
      ) : null}
      {bot.unread && !bot.working ? (
        <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-brand" />
      ) : null}
    </span>
  );
}
