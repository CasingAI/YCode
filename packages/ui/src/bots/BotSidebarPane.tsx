import { useEffect, useState } from "react";
import { BotRosterPane } from "@/bots/BotRosterPane.js";
import { hasVisibleBots } from "@/bots/botRosterLogic.js";
import { useBotRosterStore } from "@/bots/botRosterStore.js";
import type { BotWorkspaceOption } from "@/bots/botRosterTypes.js";

export function BotSidebarPane({
  workspaceOptions,
  previousViewRestore,
  viewActive = true,
}: {
  workspaceOptions: BotWorkspaceOption[];
  previousViewRestore?: () => void;
  viewActive?: boolean;
}) {
  const snapshot = useBotRosterStore((state) => state);
  const empty = !hasVisibleBots(snapshot);
  const [createOpen, setCreateOpen] = useState(viewActive && empty);

  useEffect(() => {
    if (!viewActive) {
      setCreateOpen(false);
      return;
    }
    if (empty) {
      setCreateOpen(true);
    }
  }, [empty, viewActive]);

  return (
    <BotRosterPane
      workspaceOptions={workspaceOptions}
      onNeedCreate={empty}
      createOpen={createOpen}
      onCreateOpenChange={setCreateOpen}
      previousViewRestore={previousViewRestore}
    />
  );
}
