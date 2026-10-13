import { useMemo } from "react";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { BotWorkspaceOption } from "@/bots/botRosterTypes.js";

export function useBotWorkspaceOptions(): BotWorkspaceOption[] {
  const tabs = useTabStore((state) => state.tabs);
  return useMemo(
    () =>
      tabs.filter(isWorkspaceTab).map((tab) => ({
        key: tab.workspaceIdentity?.trim() || tab.workspacePath,
        label: tab.label,
      })),
    [tabs],
  );
}
