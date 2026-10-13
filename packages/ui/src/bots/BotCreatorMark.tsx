import { useBotRosterStore } from "@/bots/botRosterStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { cn } from "@/components/lib/utils.js";

export function BotCreatorMark({ creatorBotId }: { creatorBotId?: string }) {
  const bot = useBotRosterStore((state) =>
    creatorBotId
      ? state.bots.find((candidate) => candidate.id === creatorBotId && !candidate.hidden)
      : undefined,
  );
  const openBotsTab = useTabStore((state) => state.openBotsTab);
  const setActiveBot = useBotRosterStore((state) => state.setActiveBot);

  if (!bot) {
    return null;
  }

  return (
    <button
      type="button"
      data-testid="bot-creator-mark"
      title={bot.name}
      aria-label={bot.name}
      className={cn(
        "flex size-[22px] shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[13px] leading-none transition-transform hover:scale-105",
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openBotsTab();
        setActiveBot(bot.id);
      }}
    >
      <span aria-hidden="true">{bot.emoji}</span>
    </button>
  );
}
