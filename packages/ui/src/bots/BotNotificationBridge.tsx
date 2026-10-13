import { useEffect, useRef } from "react";
import { botNotificationTaskId } from "@zcode/shared";
import { playSoundForStatus } from "@/lib/taskNotificationSound.js";
import { anyUnread } from "@/bots/botRosterLogic.js";
import { useBotRosterStore } from "@/bots/botRosterStore.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveWorkspaceShellPrimaryView } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";

export function BotNotificationBridge() {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const bots = useBotRosterStore((state) => state.bots);
  const unread = useBotRosterStore((state) => anyUnread(state));
  const previousUnreadRef = useRef(unread);
  const primaryView = useTabStore((state) =>
    resolveWorkspaceShellPrimaryView(state.tabs.find((tab) => tab.id === state.activeTabId)),
  );

  useEffect(() => {
    const cued = bots.filter((bot) => bot.notifyCue);
    if (cued.length === 0) {
      const becameUnread = unread && !previousUnreadRef.current;
      previousUnreadRef.current = unread;
      if (becameUnread) {
        void playSoundForStatus("bot_message");
      }
      return;
    }
    previousUnreadRef.current = unread;
    for (const bot of cued) {
      const cue = bot.notifyCue;
      if (!cue) {
        continue;
      }
      useBotRosterStore.setState((state) => ({
        bots: state.bots.map((candidate) =>
          candidate.id === bot.id ? { ...candidate, notifyCue: undefined } : candidate,
        ),
      }));
      const looking = primaryView === "bots" && document.hasFocus();
      if (looking) {
        void playSoundForStatus(cue);
        continue;
      }
      if (document.hasFocus()) {
        void playSoundForStatus(cue);
        continue;
      }
      if (!platform) {
        void playSoundForStatus(cue);
        continue;
      }
      try {
        platform.showTaskNotification({
          taskId: botNotificationTaskId(bot.id),
          status: cue,
          title: bot.name,
          body:
            cue === "elicitation_request"
              ? intl.formatMessage({ id: "bots.notify.waiting" }, { name: bot.name })
              : cue === "failed"
                ? intl.formatMessage({ id: "bots.notify.failed" }, { name: bot.name })
                : cue === "completed"
                  ? intl.formatMessage({ id: "bots.notify.ended" }, { name: bot.name })
                  : intl.formatMessage({ id: "bots.notify.message" }, { name: bot.name }),
        });
      } catch {
        void playSoundForStatus(cue);
      }
    }
  }, [bots, intl, platform, primaryView, unread]);

  return null;
}
