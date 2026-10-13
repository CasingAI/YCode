import {
  BOT_ROSTER_STORAGE_KEY,
  type BotRosterSnapshot,
} from "@/bots/botRosterTypes.js";
import { emptyBotRosterSnapshot } from "@/bots/botRosterLogic.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseBotRosterSnapshot(raw: string | null): BotRosterSnapshot {
  if (!raw) {
    return emptyBotRosterSnapshot();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bots)) {
      return emptyBotRosterSnapshot();
    }
    return {
      version: 1,
      bots: parsed.bots as BotRosterSnapshot["bots"],
      pinOrder: Array.isArray(parsed.pinOrder) ? (parsed.pinOrder as string[]) : [],
      listOrder: Array.isArray(parsed.listOrder) ? (parsed.listOrder as string[]) : [],
      activeBotId: typeof parsed.activeBotId === "string" ? parsed.activeBotId : undefined,
      transcripts: isRecord(parsed.transcripts)
        ? (parsed.transcripts as BotRosterSnapshot["transcripts"])
        : {},
    };
  } catch {
    return emptyBotRosterSnapshot();
  }
}

export function loadBotRosterSnapshot(): BotRosterSnapshot {
  try {
    return parseBotRosterSnapshot(window.localStorage.getItem(BOT_ROSTER_STORAGE_KEY));
  } catch {
    return emptyBotRosterSnapshot();
  }
}

export function saveBotRosterSnapshot(snapshot: BotRosterSnapshot): void {
  try {
    window.localStorage.setItem(BOT_ROSTER_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // quota / private mode
  }
}
