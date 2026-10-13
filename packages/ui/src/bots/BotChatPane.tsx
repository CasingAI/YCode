import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { BotSettingsDialog } from "@/bots/BotSettingsDialog.js";
import { botNotesDisplayPath } from "@zcode/shared";
import { latestPendingAsk, planBotLocalTurn } from "@/bots/botLocalTurn.js";
import { useBotRosterStore } from "@/bots/botRosterStore.js";
import { useBotIdleHousekeep } from "@/bots/useBotIdleHousekeep.js";
import { useBotSessionTurn } from "@/bots/useBotSessionTurn.js";
import { classifyBotDrop, droppedFilesToAttachments } from "@/bots/botDropIntake.js";
import type { BotTranscriptItem, BotWorkspaceOption } from "@/bots/botRosterTypes.js";
import type { OpenScopedSubagentDirectorySideTabRequest } from "@/lib/workspaceSidePane.js";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";

export function BotChatPane({
  workspaceOptions,
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onSelectTask,
  onOpenWorkerDirectory,
}: {
  workspaceOptions: BotWorkspaceOption[];
  workspaceAbsPath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onSelectTask?: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onOpenWorkerDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const ensureWorkspaceTab = useOptionalTabStore((state) => state.ensureWorkspaceTab);
  const snapshot = useBotRosterStore((state) => state);
  const bot = snapshot.bots.find((candidate) => candidate.id === snapshot.activeBotId && !candidate.hidden);
  const pendingDrop = useBotRosterStore((state) => state.pendingFilesystemDrop);
  const queueFilesystemDrop = useBotRosterStore((state) => state.queueFilesystemDrop);
  const clearFilesystemDrop = useBotRosterStore((state) => state.clearFilesystemDrop);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const appendUserMessage = useBotRosterStore((state) => state.appendUserMessage);
  const appendBotMessage = useBotRosterStore((state) => state.appendBotMessage);
  const appendEvent = useBotRosterStore((state) => state.appendEvent);
  const appendAsk = useBotRosterStore((state) => state.appendAsk);
  const dismissAsk = useBotRosterStore((state) => state.dismissAsk);
  const answerAsk = useBotRosterStore((state) => state.answerAsk);
  const setWorking = useBotRosterStore((state) => state.setWorking);
  const updateBot = useBotRosterStore((state) => state.updateBot);
  const { sendViaRuntime, answerViaRuntime, occupiedLabel } = useBotSessionTurn({
    bot,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  useBotIdleHousekeep({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });

  const transcript = bot ? (snapshot.transcripts[bot.id] ?? []) : [];
  const suggestions = useMemo(() => {
    if (!bot || transcript.length > 0) {
      return [];
    }
    return [
      intl.formatMessage({ id: "bots.suggest.lookAround" }),
      intl.formatMessage({ id: "bots.suggest.status" }),
      intl.formatMessage({ id: "bots.suggest.help" }),
    ];
  }, [bot, intl, transcript.length]);

  const send = (text: string, attachments?: AttachmentRef[]) => {
    if (!bot) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) {
      return;
    }
    const pendingAsk = latestPendingAsk(transcript);
    if (pendingAsk) {
      dismissAsk(bot.id, pendingAsk.id);
    }
    if (bot.working) {
      setWorking(bot.id, false);
      appendEvent(bot.id, intl.formatMessage({ id: "bots.event.interrupted" }), "stop");
    }
    if (trimmed) {
      appendUserMessage(bot.id, trimmed);
    }
    setDraft("");
    void sendViaRuntime(trimmed || intl.formatMessage({ id: "bots.drop.file" }), attachments).then(
      (accepted) => {
        if (accepted) {
          return;
        }
        const turn = planBotLocalTurn({
          text: trimmed,
          intlYes: intl.formatMessage({ id: "bots.ask.yes" }),
          intlNo: intl.formatMessage({ id: "bots.ask.no" }),
        });
        window.setTimeout(() => {
          const looking = useBotRosterStore.getState().activeBotId === bot.id;
          if (turn.kind === "ask") {
            appendAsk(bot.id, intl.formatMessage({ id: "bots.chat.stubReply" }), turn.choices);
            return;
          }
          if (turn.kind === "worker") {
            setWorking(bot.id, true);
            appendEvent(bot.id, intl.formatMessage({ id: "bots.status.working" }), "worker");
            window.setTimeout(() => {
              setWorking(bot.id, false);
              appendEvent(bot.id, intl.formatMessage({ id: "bots.event.workerDone" }), "worker");
              appendBotMessage(bot.id, intl.formatMessage({ id: "bots.chat.stubReply" }), !looking);
            }, 900);
            return;
          }
          appendBotMessage(bot.id, intl.formatMessage({ id: "bots.chat.stubReply" }), !looking);
        }, 280);
      },
    );
  };

  useEffect(() => {
    if (!bot || !pendingDrop || pendingDrop.botId !== bot.id) {
      return;
    }
    const folderPath = pendingDrop.folders[0];
    const files = pendingDrop.files;
    clearFilesystemDrop();
    if (folderPath) {
      ensureWorkspaceTab(folderPath);
      updateBot(bot.id, { workspaceKey: folderPath });
      appendEvent(bot.id, intl.formatMessage({ id: "bots.drop.folder" }), "task");
      send(intl.formatMessage({ id: "bots.drop.folderMessage" }, { path: folderPath }));
    }
    if (files.length > 0) {
      const names = files.map((file) => file.name).join("、");
      const attachments = droppedFilesToAttachments(files);
      appendEvent(bot.id, intl.formatMessage({ id: "bots.drop.file" }), "worker");
      send(
        intl.formatMessage({ id: "bots.drop.fileMessage" }, { names }),
        attachments.length > 0 ? attachments : undefined,
      );
    }
  }, [appendEvent, bot, clearFilesystemDrop, ensureWorkspaceTab, intl, pendingDrop, send, updateBot]);

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDropActive(false);
    if (!bot) {
      return;
    }
    const intake = classifyBotDrop({
      files: Array.from(event.dataTransfer.files),
      uriList: event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"),
      getPathForFile: (file) => platform?.getPathForFile?.(file)?.trim() || undefined,
    });
    if (intake.kind === "empty") {
      appendEvent(bot.id, intl.formatMessage({ id: "bots.drop.noFolderPath" }), "task");
      return;
    }
    queueFilesystemDrop({
      botId: bot.id,
      folders: intake.kind === "folders" ? intake.paths : [],
      files: intake.kind === "files" ? intake.files : [],
    });
  };

  if (!bot) {
    return (
      <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "bots.chat.emptyPerson" })}
      </div>
    );
  }

  const openEventTarget = (item: BotTranscriptItem) => {
    if (item.eventKind === "task" && item.targetSessionId && workspaceAbsPath && onSelectTask) {
      onSelectTask(workspaceAbsPath, item.targetSessionId, workspaceIdentity);
    }
  };

  const openWorkerDirectory = () => {
    if (!bot.sessionId || !workspaceAbsPath || !onOpenWorkerDirectory) {
      return;
    }
    onOpenWorkerDirectory({
      workspacePath: workspaceAbsPath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
      parentSessionId: bot.sessionId,
      rootSessionId: bot.sessionId,
    });
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background"
      data-testid="bot-chat-pane"
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      {dropActive ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-brand/10 text-ui-sm">
          {intl.formatMessage({ id: "bots.drop.file" })}
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
        <motion.button
          type="button"
          layout
          className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 shadow-sm transition-transform hover:scale-[1.02]"
          onClick={() => setSettingsOpen(true)}
          data-testid="bot-island-capsule"
        >
          <span className="text-ui-base">{bot.emoji}</span>
          <span className="text-ui-sm">{bot.name}</span>
        </motion.button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-20">
        <AnimatePresence initial={false}>
          {transcript.map((item) => (
            <BotBubble
              key={item.id}
              item={item}
              onOpenEvent={() => openEventTarget(item)}
              onAnswer={(choiceId) => {
                answerAsk(bot.id, item.id, choiceId);
                void answerViaRuntime(item.interactionId, choiceId);
              }}
            />
          ))}
        </AnimatePresence>
      </div>
      {bot.working ? (
        <motion.button
          type="button"
          layout
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-4 mb-2 rounded-md bg-accent px-3 py-1.5 text-left text-ui-xs text-foreground-subtle transition-colors hover:bg-accent/80"
          data-testid="bot-status-bar"
          onClick={openWorkerDirectory}
        >
          {occupiedLabel ?? intl.formatMessage({ id: "bots.status.working" })}
        </motion.button>
      ) : null}
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {suggestions.map((suggestion) => (
            <Button key={suggestion} type="button" size="sm" variant="outline" onClick={() => send(suggestion)}>
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className="border-t border-border px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={intl.formatMessage({ id: "bots.composer.placeholder" }, { name: bot.name })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              // 不能用闭包里的 draft：同帧 onChange+Enter 时 state 尚未提交。
              send(event.currentTarget.value);
            }
          }}
          className="min-h-12"
        />
      </form>
      <BotSettingsDialog
        bot={bot}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        workspaceOptions={workspaceOptions}
        notesPath={botNotesDisplayPath(bot.id)}
      />
    </div>
  );
}

function eventLabel(item: BotTranscriptItem, intl: ReturnType<typeof useZCodeIntl>["intl"]): string {
  switch (item.eventCode) {
    case "task_ended":
      return intl.formatMessage({ id: "bots.event.taskEnded" });
    case "task_waiting":
      return intl.formatMessage({ id: "bots.event.taskWaiting" });
    case "task_subscribed":
      return intl.formatMessage({ id: "bots.event.taskSubscribed" });
    case "task_answered":
      return intl.formatMessage({ id: "bots.event.taskAnswered" });
    case "task_plan":
      return intl.formatMessage({ id: "bots.event.taskPlan" });
    default:
      return item.text;
  }
}

function BotBubble({
  item,
  onAnswer,
  onOpenEvent,
}: {
  item: BotTranscriptItem;
  onAnswer: (choiceId: string) => void;
  onOpenEvent: () => void;
}) {
  const { intl } = useZCodeIntl();
  const compactAsk = Boolean(item.ask?.dismissed || item.ask?.selectedId);
  if (item.kind === "event") {
    // 只有带目标任务的过程条才可点；其余（含残留工人条）只是说明，不装成按钮。
    const clickable = item.eventKind === "task" && Boolean(item.targetSessionId);
    const eventChipClass =
      "inline-flex max-w-[min(100%,20rem)] items-center justify-center rounded-md border border-border/50 bg-transparent px-2 py-0.5 text-center text-ui-xs text-foreground-muted";
    return (
      <div className="relative z-0 my-1.5 flex justify-center px-2">
        {clickable ? (
          <button
            type="button"
            onClick={onOpenEvent}
            className={cn(eventChipClass, "transition-colors hover:bg-surface-hover hover:text-foreground-subtle")}
          >
            {eventLabel(item, intl)}
          </button>
        ) : (
          <div className={eventChipClass}>{eventLabel(item, intl)}</div>
        )}
      </div>
    );
  }
  const mine = item.kind === "user";
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: compactAsk ? 0.96 : 1 }}
      className={cn("relative z-0 mb-2 flex", mine ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2 text-ui-sm transition-all",
          mine ? "bg-brand text-primary-foreground" : "bg-card text-foreground",
          compactAsk && "max-w-[60%] py-1 text-ui-xs opacity-80",
        )}
      >
        <p>{item.text}</p>
        {item.kind === "ask" && item.ask && !item.ask.dismissed ? (
          <div className="mt-2 flex gap-2">
            {item.ask.choices.map((choice) => {
              const selected = item.ask?.selectedId === choice.id;
              const disabled = Boolean(item.ask?.selectedId);
              return (
                <Button
                  key={choice.id}
                  type="button"
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  disabled={disabled && !selected}
                  className={cn(disabled && !selected && "opacity-40")}
                  onClick={() => onAnswer(choice.id)}
                >
                  {choice.label}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
