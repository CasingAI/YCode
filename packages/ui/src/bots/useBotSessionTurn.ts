import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentRef, CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { BOT_ASK_USER_TOOL } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionLease,
} from "@/v4/workspaceConnectionRegistry.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  cueForProjectedItem,
  mergeProjectedTranscript,
  reusableBotSessionId,
} from "@/bots/botRosterLogic.js";
import { resolveWorkspaceShellPrimaryView } from "@/store/tabStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  isBotConversationWorking,
  projectBotTranscript,
  toBotProjectionRows,
} from "@/bots/botSessionProjection.js";
import { useBotRosterStore } from "@/bots/botRosterStore.js";
import type { BotRecord } from "@/bots/botRosterTypes.js";

type HeldLease = {
  connection: WorkspaceConnectionLease;
  session: SessionLease | undefined;
};

function workspaceScope(workspaceAbsPath: string, workspaceIdentity?: string) {
  return {
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity?.trim() ? { workspaceIdentity: workspaceIdentity.trim() } : {}),
  };
}

export function useBotSessionTurn(params: {
  bot?: BotRecord;
  workspaceAbsPath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): {
  runtimeReady: boolean;
  occupiedLabel?: string;
  sendViaRuntime: (text: string, attachments?: AttachmentRef[]) => Promise<boolean>;
  answerViaRuntime: (interactionId: string | undefined, selectedId: string) => Promise<boolean>;
} {
  const { bot, workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId } = params;
  const { intl, locale } = useZCodeIntl();
  const bindSession = useBotRosterStore((state) => state.bindSession);
  const replaceTranscript = useBotRosterStore((state) => state.replaceTranscript);
  const setWorking = useBotRosterStore((state) => state.setWorking);
  const tabStore = useTabStoreApi();
  const appendEvent = useBotRosterStore((state) => state.appendEvent);
  const { services, targetReady } = useWorkspaceServicesResolution(
    workspaceAbsPath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const agentService = targetReady ? services.zcodeAgentService : undefined;
  const runtimeReady = Boolean(workspaceAbsPath && agentService);
  const [occupiedLabel, setOccupiedLabel] = useState<string | undefined>();
  const heldRef = useRef<HeldLease | undefined>(undefined);

  const releaseHeld = useCallback(() => {
    const held = heldRef.current;
    heldRef.current = undefined;
    held?.session?.release();
    held?.connection.release();
  }, []);

  const applySnapshot = useCallback(
    (botId: string) => {
      const session = heldRef.current?.session;
      const snapshot = session?.store.getState().snapshot;
      if (!snapshot) {
        return;
      }
      const projected = projectBotTranscript({
        rows: toBotProjectionRows(snapshot.rows.window),
        pendingAsks: snapshot.pendingInteractions.flatMap((interaction) => {
          if (interaction.payload.kind !== "userInput") {
            return [];
          }
          if (interaction.payload.toolName !== BOT_ASK_USER_TOOL) {
            return [];
          }
          return [
            {
              interactionId: interaction.interactionId,
              toolName: interaction.payload.toolName,
              prompt: interaction.payload.prompt,
              options: interaction.payload.options,
              input: interaction.payload.input,
            },
          ];
        }),
      });
      const existing = useBotRosterStore.getState().transcripts[botId] ?? [];
      const merged = mergeProjectedTranscript(existing, projected);
      const known = new Set(existing.flatMap((item) => (item.sourceId ? [item.sourceId] : [])));
      const added = merged.filter((item) => item.sourceId && !known.has(item.sourceId));
      const tabState = tabStore.getState();
      const looking =
        resolveWorkspaceShellPrimaryView(
          tabState.tabs.find((tab) => tab.id === tabState.activeTabId),
        ) === "bots" && useBotRosterStore.getState().activeBotId === botId;
      const notifyCue = cueForProjectedItem(added.at(-1));
      replaceTranscript(
        botId,
        merged,
        looking || !notifyCue ? undefined : { markUnread: true, notifyCue },
      );
      const running = snapshot.subagents?.running[0];
      setOccupiedLabel(running?.title);
      setWorking(botId, isBotConversationWorking(snapshot.control.phase) || Boolean(running));
    },
    [replaceTranscript, setWorking, tabStore],
  );

  const ensureSession = useCallback(
    async (text: string, attachments?: AttachmentRef[]): Promise<string | undefined> => {
      if (!workspaceAbsPath || !agentService || !bot) {
        return undefined;
      }
      const workspaceId = workspaceIdentity?.trim() || workspaceAbsPath;
      let held = heldRef.current;
      if (!held) {
        const connection = acquireWorkspaceConnection(
          workspaceScope(workspaceAbsPath, workspaceIdentity),
          agentService,
        );
        held = { connection, session: undefined };
        heldRef.current = held;
      }
      const reusableId = reusableBotSessionId(bot.sessionId);
      if (reusableId) {
        if (!held.session) {
          held.session = held.connection.layer.acquire(reusableId);
          held.session.store.subscribe(() => applySnapshot(bot.id));
        }
        return reusableId;
      }
      // 名册若绑了普通任务会话，丢掉后再建岗位会话，避免对人消息写回任务列表。
      if (held.session) {
        held.session.release();
        held.session = undefined;
      }
      const ack: CommandAck = await held.connection.transport.sendCommand(
        createCommandEnvelope({
          type: "createSession",
          sessionId: null,
          payload: {
            workspaceId,
            botSession: true,
            botId: bot.id,
            firstInput: {
              text,
              ...(attachments && attachments.length > 0 ? { attachments } : {}),
            },
            config: {
              language: locale.startsWith("zh") ? "zh-CN" : "en-US",
            },
          },
        }),
      );
      if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
        logger.warn("[bot-session] createSession 被拒", {
          reasonCode: ack.reasonCode,
          message: ack.message,
        });
        return undefined;
      }
      const sessionId = ack.result.sessionId;
      if (!reusableBotSessionId(sessionId)) {
        logger.warn("[bot-session] createSession 没有建成岗位会话", {
          sessionId,
        });
        return undefined;
      }
      bindSession(bot.id, sessionId);
      held.session = held.connection.layer.acquire(sessionId);
      held.session.store.subscribe(() => applySnapshot(bot.id));
      applySnapshot(bot.id);
      return sessionId;
    },
    [
      agentService,
      applySnapshot,
      bindSession,
      bot,
      locale,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );

  const sendViaRuntime = useCallback(
    async (text: string, attachments?: AttachmentRef[]): Promise<boolean> => {
      if (!runtimeReady || !bot) {
        return false;
      }
      try {
        // 已有岗位会话才需要再发 sendText；新建会话时 firstInput 已带上本句，避免双发。
        const alreadyBound = Boolean(reusableBotSessionId(bot.sessionId));
        const sessionId = await ensureSession(text, attachments);
        if (!sessionId) {
          appendEvent(bot.id, intl.formatMessage({ id: "bots.runtime.unreachable" }), "stop");
          return false;
        }
        if (alreadyBound) {
          const held = heldRef.current;
          if (!held) {
            return false;
          }
          if (bot.working) {
            await held.connection.transport.sendCommand(
              createCommandEnvelope({ type: "stop", sessionId, payload: {} }),
            );
          }
          const ack: CommandAck = await held.connection.transport.sendCommand(
            createCommandEnvelope({
              type: "sendText",
              sessionId,
              payload: {
                text,
                requestedDelivery: "startNow",
                ...(attachments && attachments.length > 0 ? { attachments } : {}),
              },
            }),
          );
          if (ack.status !== "accepted") {
            appendEvent(bot.id, intl.formatMessage({ id: "bots.runtime.unreachable" }), "stop");
            return false;
          }
        }
        setWorking(bot.id, true);
        return true;
      } catch (error) {
        logger.warn("[bot-session] 发送失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        appendEvent(bot.id, intl.formatMessage({ id: "bots.runtime.unreachable" }), "stop");
        return false;
      }
    },
    [appendEvent, bot, ensureSession, intl, runtimeReady, setWorking],
  );

  const answerViaRuntime = useCallback(
    async (interactionId: string | undefined, selectedId: string): Promise<boolean> => {
      const held = heldRef.current;
      const sessionId = reusableBotSessionId(bot?.sessionId);
      if (!held || !sessionId || !interactionId) {
        return false;
      }
      try {
        const ack: CommandAck = await held.connection.transport.sendCommand(
          createCommandEnvelope({
            type: "resolveInteraction",
            sessionId,
            payload: {
              interactionId,
              answer: { optionId: selectedId, action: "accept", content: { selectedId } },
            },
          }),
        );
        return ack.status === "accepted";
      } catch (error) {
        logger.warn("[bot-session] 询问应答失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    [bot?.sessionId],
  );

  useEffect(() => {
    return () => {
      releaseHeld();
    };
  }, [releaseHeld, bot?.id]);

  useEffect(() => {
    const reusableId = reusableBotSessionId(bot?.sessionId);
    const botId = bot?.id;
    if (!reusableId || !botId || !runtimeReady || !agentService || !workspaceAbsPath) {
      return;
    }
    if (heldRef.current?.session) {
      return;
    }
    const connection = acquireWorkspaceConnection(
      workspaceScope(workspaceAbsPath, workspaceIdentity),
      agentService,
    );
    const session = connection.layer.acquire(reusableId);
    heldRef.current = { connection, session };
    const unsubscribe = session.store.subscribe(() => applySnapshot(botId));
    applySnapshot(botId);
    return () => {
      unsubscribe();
    };
  }, [agentService, applySnapshot, bot?.id, bot?.sessionId, runtimeReady, workspaceAbsPath, workspaceIdentity]);

  return { runtimeReady, occupiedLabel, sendViaRuntime, answerViaRuntime };
}
