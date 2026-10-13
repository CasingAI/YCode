import { useEffect } from "react";
import {
  BOT_HOUSEKEEP_PROMPT,
  BOT_IDLE_HOUSEKEEP_MS,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { shouldHousekeepBot } from "@/bots/botRosterLogic.js";
import { useBotRosterStore } from "@/bots/botRosterStore.js";

function workspaceScope(workspaceAbsPath: string, workspaceIdentity?: string) {
  return {
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity?.trim() ? { workspaceIdentity: workspaceIdentity.trim() } : {}),
  };
}

export function useBotIdleHousekeep(params: {
  workspaceAbsPath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): void {
  const { workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId } = params;
  const setWorking = useBotRosterStore((state) => state.setWorking);
  const { services, targetReady } = useWorkspaceServicesResolution(
    workspaceAbsPath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const agentService = targetReady ? services.zcodeAgentService : undefined;

  useEffect(() => {
    if (!workspaceAbsPath || !agentService) {
      return;
    }
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const bot of useBotRosterStore.getState().bots) {
        if (!shouldHousekeepBot(bot, now, BOT_IDLE_HOUSEKEEP_MS) || !bot.sessionId) {
          continue;
        }
        const sessionId = bot.sessionId;
        const botId = bot.id;
        setWorking(botId, true);
        const connection = acquireWorkspaceConnection(
          workspaceScope(workspaceAbsPath, workspaceIdentity),
          agentService,
        );
        void connection.transport
          .sendCommand(
            createCommandEnvelope({
              type: "compact",
              sessionId,
              payload: {
                instructions:
                  "Persist durable notes with bot_memory. Do not call bot_send_message or bot_ask_user.",
              },
            }),
          )
          .then((compactAck) => {
            if (compactAck.status !== "accepted") {
              logger.warn("[bot-session] 闲置压缩未受理", {
                reasonCode: compactAck.reasonCode,
              });
            }
            return connection.transport.sendCommand(
              createCommandEnvelope({
                type: "sendText",
                sessionId,
                payload: { text: BOT_HOUSEKEEP_PROMPT, requestedDelivery: "queue" },
              }),
            );
          })
          .catch((error) => {
            logger.warn("[bot-session] 闲置家务失败", {
              error: error instanceof Error ? error.message : String(error),
            });
            setWorking(botId, false);
          })
          .finally(() => {
            connection.release();
          });
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [agentService, setWorking, workspaceAbsPath, workspaceIdentity]);
}
