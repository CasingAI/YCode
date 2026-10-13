import { useEffect, useState } from "react";
import { useBotRosterStore } from "@/bots/botRosterStore.js";
import { reusableBotSessionId, visibleBots } from "@/bots/botRosterLogic.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { formatSummaryCompactTokenUsage } from "@/settings/usage-stats/usageStatsUiParts.js";

export function BotUsageList() {
  const { intl, locale } = useZCodeIntl();
  // selector 必须返回可 Object.is 的稳定值；visibleBots() 每次新建数组会触发无限重渲染。
  const rosterKey = useBotRosterStore((state) =>
    visibleBots(state)
      .map((bot) => `${bot.id}:${reusableBotSessionId(bot.sessionId) ?? ""}`)
      .join("|"),
  );
  const bots = useBotRosterStore((state) => state.bots).filter((bot) => !bot.hidden);
  const workspacePath = useOptionalTabStore((state) => state.activeWorkspacePath ?? undefined);
  const workspaceIdentity = useOptionalTabStore((state) => state.activeWorkspaceIdentity ?? undefined);
  const remoteSessionId = useOptionalTabStore((state) => {
    const path = state.activeWorkspacePath;
    if (!path) {
      return undefined;
    }
    const identity = state.activeWorkspaceIdentity ?? undefined;
    const match = state.tabs.filter(isWorkspaceTab).find((tab) => {
      if (tab.workspacePath !== path) {
        return false;
      }
      return identity ? tab.workspaceIdentity === identity : !tab.workspaceIdentity;
    });
    return match?.remoteSessionId;
  });
  const agentService = useZCodeAgentService(workspacePath, remoteSessionId, workspaceIdentity);
  const [usageByBotId, setUsageByBotId] = useState<Record<string, number | undefined>>({});

  useEffect(() => {
    const visible = visibleBots(useBotRosterStore.getState());
    if (!workspacePath || visible.length === 0) {
      setUsageByBotId({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      visible.map(async (bot) => {
        const sessionId = reusableBotSessionId(bot.sessionId);
        if (!sessionId) {
          return [bot.id, undefined] as const;
        }
        try {
          const result = await agentService.getTaskTokenUsage({
            sessionId,
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
          });
          return [bot.id, result.totalTokens] as const;
        } catch {
          return [bot.id, undefined] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) {
        return;
      }
      setUsageByBotId(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [agentService, remoteSessionId, rosterKey, workspaceIdentity, workspacePath]);

  if (bots.length === 0) {
    return undefined;
  }

  return (
    <section className="space-y-2" data-testid="bot-usage-list">
      <h3 className="text-ui-sm font-medium text-foreground">
        {intl.formatMessage({ id: "bots.usage.title" })}
      </h3>
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "bots.usage.hint" })}
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {bots.map((bot) => {
          const sessionId = reusableBotSessionId(bot.sessionId);
          const tokens = usageByBotId[bot.id];
          const label = !workspacePath
            ? intl.formatMessage({ id: "bots.usage.unavailable" })
            : !sessionId
              ? intl.formatMessage({ id: "bots.usage.none" })
              : tokens === undefined
                ? intl.formatMessage({ id: "bots.usage.pending" })
                : formatSummaryCompactTokenUsage(locale, tokens);
          return (
            <li key={bot.id} className="flex items-center justify-between gap-2 px-3 py-2 text-ui-sm">
              <span className="min-w-0 truncate">
                {bot.emoji} {bot.name}
              </span>
              <span className="shrink-0 text-foreground-subtle">{label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
