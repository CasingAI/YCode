import type { BotTranscriptItem } from "@/bots/botRosterTypes.js";

export type BotLocalTurn =
  | { kind: "message"; text: string }
  | { kind: "ask"; text: string; choices: { id: string; label: string }[] }
  | { kind: "worker"; text: string };

export function planBotLocalTurn(input: { text: string; intlYes: string; intlNo: string }): BotLocalTurn {
  const trimmed = input.text.trim();
  if (/[?？]|吗$|嘛$/.test(trimmed)) {
    return {
      kind: "ask",
      text: trimmed,
      choices: [
        { id: "yes", label: input.intlYes },
        { id: "no", label: input.intlNo },
      ],
    };
  }
  if (/看看|看一下|look|status|进度|盯/.test(trimmed.toLowerCase())) {
    return { kind: "worker", text: trimmed };
  }
  return { kind: "message", text: trimmed };
}

export function latestPendingAsk(
  items: readonly BotTranscriptItem[],
): BotTranscriptItem | undefined {
  return [...items]
    .reverse()
    .find((item) => item.kind === "ask" && !item.ask?.selectedId && !item.ask?.dismissed);
}
