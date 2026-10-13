import { create } from "zustand";
import { createUuid } from "@zcode/shared";
import {
  BOT_NONE_WORKSPACE,
  type BotRecord,
  type BotRosterSnapshot,
  type BotTranscriptItem,
} from "@/bots/botRosterTypes.js";
import {
  answerAsk,
  appendTranscriptItem,
  bindBotSession,
  dismissAsk,
  hideBot,
  insertCreatedBot,
  pinBot,
  reorderIds,
  replaceTranscript as replaceTranscriptItems,
  setActiveBot,
  setBotWorking,
  unpinBot,
  updateBot,
} from "@/bots/botRosterLogic.js";
import { loadBotRosterSnapshot, saveBotRosterSnapshot } from "@/bots/botRosterPersistence.js";
import type { BotDroppedFile } from "@/bots/botDropIntake.js";

export interface CreateBotInput {
  name: string;
  emoji: string;
  background: string;
  workspaceKey: string;
}

export interface BotFilesystemDrop {
  botId: string;
  folders: string[];
  files: BotDroppedFile[];
}

interface BotRosterStoreState extends BotRosterSnapshot {
  pendingFilesystemDrop?: BotFilesystemDrop;
  hydrate: () => void;
  createBot: (input: CreateBotInput) => string;
  hideBot: (botId: string) => void;
  pinBot: (botId: string) => "ok" | "full" | "missing";
  unpinBot: (botId: string) => void;
  reorderPins: (fromId: string, toId: string) => void;
  reorderList: (fromId: string, toId: string) => void;
  setActiveBot: (botId: string) => void;
  updateBot: (
    botId: string,
    patch: Partial<
      Pick<BotRecord, "name" | "emoji" | "background" | "workspaceKey" | "hideComposerModelPicker">
    >,
  ) => void;
  appendUserMessage: (botId: string, text: string) => void;
  appendBotMessage: (botId: string, text: string, markUnread: boolean) => void;
  appendEvent: (
    botId: string,
    text: string,
    eventKind: NonNullable<BotTranscriptItem["eventKind"]>,
    extra?: { targetSessionId?: string },
  ) => void;
  appendAsk: (botId: string, text: string, choices: { id: string; label: string }[]) => void;
  answerAsk: (botId: string, itemId: string, selectedId: string) => void;
  dismissAsk: (botId: string, itemId: string) => void;
  setWorking: (botId: string, working: boolean) => void;
  bindSession: (botId: string, sessionId: string) => void;
  replaceTranscript: (
    botId: string,
    items: BotTranscriptItem[],
    options?: { markUnread?: boolean; notifyCue?: BotRecord["notifyCue"] },
  ) => void;
  queueFilesystemDrop: (payload: BotFilesystemDrop) => void;
  clearFilesystemDrop: () => void;
}

function persist(snapshot: BotRosterSnapshot): BotRosterSnapshot {
  saveBotRosterSnapshot({
    ...snapshot,
    bots: snapshot.bots.map((bot) => ({ ...bot, notifyCue: undefined })),
  });
  return snapshot;
}

function snapshotOf(state: BotRosterSnapshot): BotRosterSnapshot {
  return {
    version: 1,
    bots: state.bots,
    pinOrder: state.pinOrder,
    listOrder: state.listOrder,
    activeBotId: state.activeBotId,
    transcripts: state.transcripts,
  };
}

export const useBotRosterStore = create<BotRosterStoreState>((set, get) => ({
  ...loadBotRosterSnapshot(),
  hydrate: () => {
    set(loadBotRosterSnapshot());
  },
  createBot: (input) => {
    const now = Date.now();
    const id = `bot_${createUuid()}`;
    const bot: BotRecord = {
      id,
      name: input.name.trim(),
      emoji: input.emoji,
      background: input.background.trim(),
      workspaceKey: input.workspaceKey || BOT_NONE_WORKSPACE,
      hideComposerModelPicker: true,
      hidden: false,
      createdAt: now,
      updatedAt: now,
      working: false,
      unread: false,
    };
    set((state) => persist(insertCreatedBot(snapshotOf(state), bot)));
    return id;
  },
  hideBot: (botId) => {
    set((state) => persist(hideBot(snapshotOf(state), botId)));
  },
  pinBot: (botId) => {
    const result = pinBot(snapshotOf(get()), botId);
    if (!result.ok) {
      return result.reason;
    }
    set(persist(result.snapshot));
    return "ok";
  },
  unpinBot: (botId) => {
    set((state) => persist(unpinBot(snapshotOf(state), botId)));
  },
  reorderPins: (fromId, toId) => {
    set((state) => persist({ ...snapshotOf(state), pinOrder: reorderIds(state.pinOrder, fromId, toId) }));
  },
  reorderList: (fromId, toId) => {
    set((state) => persist({ ...snapshotOf(state), listOrder: reorderIds(state.listOrder, fromId, toId) }));
  },
  setActiveBot: (botId) => {
    set((state) => persist(setActiveBot(snapshotOf(state), botId)));
  },
  updateBot: (botId, patch) => {
    set((state) => persist(updateBot(snapshotOf(state), botId, patch)));
  },
  appendUserMessage: (botId, text) => {
    const item: BotTranscriptItem = {
      id: `msg_${createUuid()}`,
      kind: "user",
      text,
      createdAt: Date.now(),
    };
    set((state) => persist(appendTranscriptItem(snapshotOf(state), botId, item)));
  },
  appendBotMessage: (botId, text, markUnread) => {
    const item: BotTranscriptItem = {
      id: `msg_${createUuid()}`,
      kind: "bot",
      text,
      createdAt: Date.now(),
    };
    set((state) => persist(appendTranscriptItem(snapshotOf(state), botId, item, { markUnread })));
  },
  appendEvent: (botId, text, eventKind, extra) => {
    const item: BotTranscriptItem = {
      id: `msg_${createUuid()}`,
      kind: "event",
      text,
      createdAt: Date.now(),
      eventKind,
      ...(extra?.targetSessionId ? { targetSessionId: extra.targetSessionId } : {}),
    };
    set((state) => persist(appendTranscriptItem(snapshotOf(state), botId, item)));
  },
  appendAsk: (botId, text, choices) => {
    const item: BotTranscriptItem = {
      id: `msg_${createUuid()}`,
      kind: "ask",
      text,
      createdAt: Date.now(),
      ask: { choices },
    };
    set((state) => persist(appendTranscriptItem(snapshotOf(state), botId, item)));
  },
  answerAsk: (botId, itemId, selectedId) => {
    set((state) => persist(answerAsk(snapshotOf(state), botId, itemId, selectedId)));
  },
  dismissAsk: (botId, itemId) => {
    set((state) => persist(dismissAsk(snapshotOf(state), botId, itemId)));
  },
  setWorking: (botId, working) => {
    set((state) => persist(setBotWorking(snapshotOf(state), botId, working)));
  },
  bindSession: (botId, sessionId) => {
    set((state) => persist(bindBotSession(snapshotOf(state), botId, sessionId)));
  },
  replaceTranscript: (botId, items, options) => {
    set((state) => persist(replaceTranscriptItems(snapshotOf(state), botId, items, options)));
  },
  queueFilesystemDrop: (payload) => {
    set({ pendingFilesystemDrop: payload });
  },
  clearFilesystemDrop: () => {
    set({ pendingFilesystemDrop: undefined });
  },
}));
