import {
  BOT_ASK_USER_TOOL,
  BOT_SEND_MESSAGE_TOOL,
  BOT_TASK_TOOL,
  isBotHousekeepUserText,
  isBotTaskWatchUserText,
  parseBotTaskWatchEvent,
  parseBotTaskWatchSessionId,
} from "@zcode/shared";
import type { BotTranscriptItem } from "@/bots/botRosterTypes.js";

export interface BotProjectionRow {
  kind: string;
  rowId?: number;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  createdAt?: number;
  origin?: string;
}

export interface BotPendingAsk {
  interactionId: string;
  toolName?: string;
  prompt?: string;
  options?: Array<{ optionId: string; label: string }>;
  input?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== undefined && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBotAsk(input: unknown): { text: string; choices: Array<{ id: string; label: string }>; selectedId?: string } | undefined {
  if (!isRecord(input) || typeof input.text !== "string" || !Array.isArray(input.choices)) {
    return undefined;
  }
  const choices = input.choices.flatMap((choice) => {
    if (!isRecord(choice) || typeof choice.id !== "string" || typeof choice.label !== "string") {
      return [];
    }
    return [{ id: choice.id, label: choice.label }];
  });
  if (choices.length === 0) {
    return undefined;
  }
  return {
    text: input.text,
    choices,
    selectedId: readString(input.selectedId),
  };
}

const WORKER_TOOL_NAMES = new Set(["Agent", "Task"]);

export function toBotProjectionRows(
  rows: ReadonlyArray<{
    kind: string;
    rowId?: number;
    createdAt?: number;
    text?: string;
    origin?: string;
    toolName?: string;
    input?: unknown;
    status?: string;
  }>,
): BotProjectionRow[] {
  return rows.map((row) => ({
    kind: row.kind,
    rowId: row.rowId,
    createdAt: row.createdAt,
    text: row.text,
    origin: row.origin,
    toolName: row.toolName,
    input: row.input,
    status: row.status,
  }));
}

export function projectBotTranscript(params: {
  rows: readonly BotProjectionRow[];
  pendingAsks?: readonly BotPendingAsk[];
}): BotTranscriptItem[] {
  const items: BotTranscriptItem[] = [];
  const pendingByTool = new Map(
    (params.pendingAsks ?? [])
      .filter((ask) => ask.toolName === BOT_ASK_USER_TOOL)
      .map((ask) => [ask.interactionId, ask]),
  );

  for (const row of params.rows) {
    if (row.kind === "userInput" && row.text?.trim()) {
      if (isBotHousekeepUserText(row.text)) {
        continue;
      }
      if (isBotTaskWatchUserText(row.text)) {
        const watchEvent = parseBotTaskWatchEvent(row.text);
        const outcome = /\boutcome=(\w+)/u.exec(row.text)?.[1];
        const watchSessionId = parseBotTaskWatchSessionId(row.text);
        items.push({
          id: `row_${row.rowId ?? items.length}`,
          kind: "event",
          text: watchEvent === "waiting_for_user" ? "waiting_for_user" : (outcome ?? "completed"),
          createdAt: row.createdAt ?? 0,
          sourceId: `watch:${row.rowId ?? items.length}`,
          eventKind: "task",
          eventCode: watchEvent === "waiting_for_user" ? "task_waiting" : "task_ended",
          ...(watchSessionId ? { targetSessionId: watchSessionId } : {}),
        });
        continue;
      }
      if (row.origin !== "realUser") {
        continue;
      }
      items.push({
        id: `row_${row.rowId ?? items.length}`,
        kind: "user",
        text: row.text,
        createdAt: row.createdAt ?? 0,
        sourceId: `user:${row.rowId ?? items.length}`,
      });
      continue;
    }
    if (row.kind !== "toolCall") {
      continue;
    }
    if (row.toolName === BOT_SEND_MESSAGE_TOOL) {
      const text = readString(isRecord(row.input) ? row.input.text : undefined);
      if (!text) {
        continue;
      }
      items.push({
        id: `row_${row.rowId ?? items.length}`,
        kind: "bot",
        text,
        createdAt: row.createdAt ?? 0,
        sourceId: `send:${row.rowId ?? items.length}`,
      });
      continue;
    }
    if (row.toolName === BOT_ASK_USER_TOOL) {
      const ask = readBotAsk(row.input);
      if (!ask) {
        continue;
      }
      items.push({
        id: `row_${row.rowId ?? items.length}`,
        kind: "ask",
        text: ask.text,
        createdAt: row.createdAt ?? 0,
        sourceId: `ask:${row.rowId ?? items.length}`,
        ask: {
          choices: ask.choices,
          selectedId: ask.selectedId,
        },
      });
      continue;
    }
    if (row.toolName === BOT_TASK_TOOL && row.status !== "error" && row.status !== "cancelled") {
      const action = readString(isRecord(row.input) ? row.input.action : undefined);
      const description = readString(
        isRecord(row.input)
          ? (row.input.title ?? row.input.action ?? row.input.sessionId)
          : undefined,
      );
      const targetSessionId = readString(isRecord(row.input) ? row.input.sessionId : undefined);
      items.push({
        id: `row_${row.rowId ?? items.length}`,
        kind: "event",
        text: description ?? BOT_TASK_TOOL,
        createdAt: row.createdAt ?? 0,
        sourceId: `tool:${row.rowId ?? items.length}`,
        eventKind: "task",
        ...(targetSessionId ? { targetSessionId } : {}),
        ...(action === "subscribe"
          ? { eventCode: "task_subscribed" as const }
          : action === "answer"
            ? { eventCode: "task_answered" as const }
            : action === "execute_plan"
              ? { eventCode: "task_plan" as const }
              : {}),
      });
      continue;
    }
    if (row.toolName && WORKER_TOOL_NAMES.has(row.toolName) && row.status !== "error" && row.status !== "cancelled") {
      const description = readString(
        isRecord(row.input) ? (row.input.description ?? row.input.prompt ?? row.input.title) : undefined,
      );
      const text = description ?? row.toolName;
      const last = items.at(-1);
      if (last?.kind === "event" && last.eventKind === "worker" && last.text === text) {
        continue;
      }
      items.push({
        id: `row_${row.rowId ?? items.length}`,
        kind: "event",
        text,
        createdAt: row.createdAt ?? 0,
        sourceId: `tool:${row.rowId ?? items.length}`,
        eventKind: "worker",
      });
    }
  }

  for (const pending of pendingByTool.values()) {
    const ask = readBotAsk(pending.input);
    const text = ask?.text ?? pending.prompt;
    const choices =
      ask?.choices ??
      (pending.options ?? []).map((option) => ({ id: option.optionId, label: option.label }));
    if (!text?.trim() || choices.length === 0) {
      continue;
    }
    if (items.some((item) => item.interactionId === pending.interactionId)) {
      continue;
    }
    const already = items.find(
      (item) => item.kind === "ask" && item.text === text && !item.ask?.selectedId,
    );
    if (already) {
      already.interactionId = pending.interactionId;
      continue;
    }
    items.push({
      id: `ask_${pending.interactionId}`,
      kind: "ask",
      text,
      createdAt: Date.now(),
      sourceId: `pending:${pending.interactionId}`,
      interactionId: pending.interactionId,
      ask: { choices },
    });
  }

  return items;
}

export function isBotConversationWorking(phase: string | undefined): boolean {
  return phase === "running" || phase === "prewarming";
}
