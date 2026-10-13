import { BOT_IDLE_HOUSEKEEP_MS, isBotSessionRecordId } from "@zcode/shared";
import {
  BOT_PIN_LIMIT,
  type BotRecord,
  type BotRosterSnapshot,
  type BotTranscriptItem,
} from "@/bots/botRosterTypes.js";

export function emptyBotRosterSnapshot(): BotRosterSnapshot {
  return {
    version: 1,
    bots: [],
    pinOrder: [],
    listOrder: [],
    transcripts: {},
  };
}

export function visibleBots(snapshot: BotRosterSnapshot): BotRecord[] {
  return snapshot.bots.filter((bot) => !bot.hidden);
}

export function pinnedVisibleBots(snapshot: BotRosterSnapshot): BotRecord[] {
  const byId = new Map(snapshot.bots.map((bot) => [bot.id, bot]));
  return snapshot.pinOrder.flatMap((id) => {
    const bot = byId.get(id);
    return bot && !bot.hidden ? [bot] : [];
  });
}

export function listedVisibleBots(snapshot: BotRosterSnapshot): BotRecord[] {
  const byId = new Map(snapshot.bots.map((bot) => [bot.id, bot]));
  const pinned = new Set(snapshot.pinOrder);
  return snapshot.listOrder.flatMap((id) => {
    if (pinned.has(id)) {
      return [];
    }
    const bot = byId.get(id);
    return bot && !bot.hidden ? [bot] : [];
  });
}

export function filterBotsByName(bots: readonly BotRecord[], query: string): BotRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...bots];
  }
  return bots.filter((bot) => bot.name.toLowerCase().includes(needle));
}

export function anyUnread(snapshot: BotRosterSnapshot): boolean {
  return visibleBots(snapshot).some((bot) => bot.unread);
}

function withBots(snapshot: BotRosterSnapshot, bots: BotRecord[]): BotRosterSnapshot {
  return { ...snapshot, bots };
}

export function insertCreatedBot(
  snapshot: BotRosterSnapshot,
  bot: BotRecord,
): BotRosterSnapshot {
  return {
    ...snapshot,
    bots: [...snapshot.bots, bot],
    listOrder: [...snapshot.listOrder, bot.id],
    activeBotId: bot.id,
    transcripts: { ...snapshot.transcripts, [bot.id]: snapshot.transcripts[bot.id] ?? [] },
  };
}

export function hideBot(snapshot: BotRosterSnapshot, botId: string): BotRosterSnapshot {
  const bots = snapshot.bots.map((bot) =>
    bot.id === botId ? { ...bot, hidden: true, updatedAt: Date.now() } : bot,
  );
  const pinOrder = snapshot.pinOrder.filter((id) => id !== botId);
  const listOrder = snapshot.listOrder.filter((id) => id !== botId);
  const remaining = bots.filter((bot) => !bot.hidden);
  const activeBotId =
    snapshot.activeBotId === botId ? remaining[0]?.id : snapshot.activeBotId;
  return { ...snapshot, bots, pinOrder, listOrder, activeBotId };
}

export function pinBot(
  snapshot: BotRosterSnapshot,
  botId: string,
): { ok: true; snapshot: BotRosterSnapshot } | { ok: false; reason: "full" | "missing" } {
  const bot = snapshot.bots.find((candidate) => candidate.id === botId && !candidate.hidden);
  if (!bot) {
    return { ok: false, reason: "missing" };
  }
  if (snapshot.pinOrder.includes(botId)) {
    return { ok: true, snapshot };
  }
  if (snapshot.pinOrder.length >= BOT_PIN_LIMIT) {
    return { ok: false, reason: "full" };
  }
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      pinOrder: [...snapshot.pinOrder, botId],
      listOrder: snapshot.listOrder.filter((id) => id !== botId),
    },
  };
}

export function unpinBot(snapshot: BotRosterSnapshot, botId: string): BotRosterSnapshot {
  if (!snapshot.pinOrder.includes(botId)) {
    return snapshot;
  }
  return {
    ...snapshot,
    pinOrder: snapshot.pinOrder.filter((id) => id !== botId),
    listOrder: snapshot.listOrder.includes(botId)
      ? snapshot.listOrder
      : [...snapshot.listOrder, botId],
  };
}

export function reorderIds(ids: readonly string[], fromId: string, toId: string): string[] {
  const next = [...ids];
  const fromIndex = next.indexOf(fromId);
  const toIndex = next.indexOf(toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return next;
  }
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) {
    return next;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

export function setActiveBot(snapshot: BotRosterSnapshot, botId: string): BotRosterSnapshot {
  const bot = snapshot.bots.find((candidate) => candidate.id === botId && !candidate.hidden);
  if (!bot) {
    return snapshot;
  }
  return withBots(
    { ...snapshot, activeBotId: botId },
    snapshot.bots.map((candidate) =>
      candidate.id === botId ? { ...candidate, unread: false, notifyCue: undefined } : candidate,
    ),
  );
}

export function updateBot(
  snapshot: BotRosterSnapshot,
  botId: string,
  patch: Partial<
    Pick<
      BotRecord,
      | "name"
      | "emoji"
      | "background"
      | "workspaceKey"
      | "hideComposerModelPicker"
    >
  >,
): BotRosterSnapshot {
  return withBots(
    snapshot,
    snapshot.bots.map((bot) =>
      bot.id === botId ? { ...bot, ...patch, updatedAt: Date.now() } : bot,
    ),
  );
}

export function appendTranscriptItem(
  snapshot: BotRosterSnapshot,
  botId: string,
  item: BotTranscriptItem,
  options?: { markUnread?: boolean },
): BotRosterSnapshot {
  const transcript = [...(snapshot.transcripts[botId] ?? []), item];
  const preview = item.kind === "ask" ? item.text : item.text;
  return {
    ...snapshot,
    transcripts: { ...snapshot.transcripts, [botId]: transcript },
    bots: snapshot.bots.map((bot) =>
      bot.id === botId
        ? {
            ...bot,
            lastPreview: preview,
            lastPreviewAt: item.createdAt,
            unread: options?.markUnread === true ? true : bot.unread,
            updatedAt: item.createdAt,
          }
        : bot,
    ),
  };
}

export function answerAsk(
  snapshot: BotRosterSnapshot,
  botId: string,
  itemId: string,
  selectedId: string,
): BotRosterSnapshot {
  const transcript = (snapshot.transcripts[botId] ?? []).map((item) => {
    if (item.id !== itemId || item.kind !== "ask" || !item.ask) {
      return item;
    }
    return { ...item, ask: { ...item.ask, selectedId, dismissed: false } };
  });
  return { ...snapshot, transcripts: { ...snapshot.transcripts, [botId]: transcript } };
}

export function dismissAsk(snapshot: BotRosterSnapshot, botId: string, itemId: string): BotRosterSnapshot {
  const transcript = (snapshot.transcripts[botId] ?? []).map((item) => {
    if (item.id !== itemId || item.kind !== "ask" || !item.ask) {
      return item;
    }
    return { ...item, ask: { ...item.ask, dismissed: true } };
  });
  return { ...snapshot, transcripts: { ...snapshot.transcripts, [botId]: transcript } };
}

export function setBotWorking(snapshot: BotRosterSnapshot, botId: string, working: boolean): BotRosterSnapshot {
  return withBots(
    snapshot,
    snapshot.bots.map((bot) =>
      bot.id === botId ? { ...bot, working, updatedAt: Date.now() } : bot,
    ),
  );
}

export function reusableBotSessionId(sessionId?: string): string | undefined {
  if (!sessionId || !isBotSessionRecordId(sessionId)) {
    return undefined;
  }
  return sessionId;
}

export function shouldHousekeepBot(
  bot: Pick<BotRecord, "hidden" | "working" | "sessionId" | "updatedAt">,
  now: number,
  idleMs = BOT_IDLE_HOUSEKEEP_MS,
): boolean {
  if (bot.hidden || bot.working || !reusableBotSessionId(bot.sessionId)) {
    return false;
  }
  return now - bot.updatedAt >= idleMs;
}

export function bindBotSession(snapshot: BotRosterSnapshot, botId: string, sessionId: string): BotRosterSnapshot {
  if (!isBotSessionRecordId(sessionId)) {
    return snapshot;
  }
  return withBots(
    snapshot,
    snapshot.bots.map((bot) => (bot.id === botId ? { ...bot, sessionId, updatedAt: Date.now() } : bot)),
  );
}

export function replaceTranscript(
  snapshot: BotRosterSnapshot,
  botId: string,
  items: BotTranscriptItem[],
  options?: { markUnread?: boolean; notifyCue?: BotRecord["notifyCue"] },
): BotRosterSnapshot {
  const last = items.at(-1);
  return {
    ...snapshot,
    transcripts: { ...snapshot.transcripts, [botId]: items },
    bots: snapshot.bots.map((bot) =>
      bot.id === botId
        ? {
            ...bot,
            ...(last
              ? { lastPreview: last.text, lastPreviewAt: last.createdAt, updatedAt: last.createdAt }
              : {}),
            ...(options?.markUnread === true ? { unread: true } : {}),
            ...(options?.notifyCue ? { notifyCue: options.notifyCue } : {}),
          }
        : bot,
    ),
  };
}

export function cueForProjectedItem(item: BotTranscriptItem | undefined): BotRecord["notifyCue"] {
  if (!item) {
    return undefined;
  }
  if (item.kind === "bot" || item.kind === "ask") {
    return "bot_message";
  }
  if (item.eventCode === "task_waiting") {
    return "elicitation_request";
  }
  if (item.eventCode === "task_ended") {
    return item.text === "failed" ? "failed" : "completed";
  }
  return undefined;
}

export function mergeProjectedTranscript(
  existing: BotTranscriptItem[],
  projected: BotTranscriptItem[],
): BotTranscriptItem[] {
  // 订阅刚挂上时 window 可能暂时为空；空投影不得抹掉已有气泡。
  if (projected.length === 0) {
    return existing;
  }
  const lastLocalUser = [...existing].reverse().find((item) => item.kind === "user" && !item.sourceId);
  if (!lastLocalUser) {
    return projected;
  }
  if (projected.some((item) => item.kind === "user" && item.text === lastLocalUser.text)) {
    return projected;
  }
  return [...projected, lastLocalUser];
}

export function hasVisibleBots(snapshot: BotRosterSnapshot): boolean {
  return visibleBots(snapshot).length > 0;
}
