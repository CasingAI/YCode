export const BOT_NONE_WORKSPACE = "__none__";
export const BOT_PIN_LIMIT = 3;
export const BOT_ROSTER_STORAGE_KEY = "zcode-bot-roster-v1";

export type BotMessageKind = "user" | "bot" | "ask" | "event";

export interface BotAskChoice {
  id: string;
  label: string;
}

export interface BotTranscriptItem {
  id: string;
  kind: BotMessageKind;
  text: string;
  createdAt: number;
  sourceId?: string;
  interactionId?: string;
  ask?: {
    choices: BotAskChoice[];
    selectedId?: string;
    dismissed?: boolean;
  };
  eventKind?: "worker" | "task" | "stop" | "housekeep";
  eventCode?: "task_ended" | "task_waiting" | "task_subscribed" | "task_answered" | "task_plan";
  targetSessionId?: string;
}

export interface BotRecord {
  id: string;
  name: string;
  emoji: string;
  background: string;
  workspaceKey: string;
  hideComposerModelPicker: boolean;
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
  lastPreview?: string;
  lastPreviewAt?: number;
  working: boolean;
  unread: boolean;
  notifyCue?: "completed" | "failed" | "elicitation_request" | "bot_message";
  sessionId?: string;
}

export interface BotRosterSnapshot {
  version: 1;
  bots: BotRecord[];
  pinOrder: string[];
  listOrder: string[];
  activeBotId?: string;
  transcripts: Record<string, BotTranscriptItem[]>;
}

export interface BotWorkspaceOption {
  key: string;
  label: string;
}
