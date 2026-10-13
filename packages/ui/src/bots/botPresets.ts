export interface BotCreatePreset {
  id: "secretary" | "overseer" | "partner";
  emoji: string;
}

export const BOT_CREATE_PRESETS: readonly BotCreatePreset[] = [
  { id: "secretary", emoji: "📎" },
  { id: "overseer", emoji: "🧭" },
  { id: "partner", emoji: "🤝" },
];
