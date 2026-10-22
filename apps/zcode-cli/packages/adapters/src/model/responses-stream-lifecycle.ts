import type { ModelStreamEvent } from "@zcode/contracts";

/** Convert only public Responses lifecycle boundaries into internal stage events. */
export function toResponsesLifecycleEvent(
  chunk: unknown,
  attemptId: string,
  observedAt = Date.now(),
): ModelStreamEvent | undefined {
  if (!isRecord(chunk) || chunk.type !== "raw" || !isRecord(chunk.rawValue)) return undefined;

  const raw = chunk.rawValue;
  if (
    raw.type !== "response.in_progress" &&
    raw.type !== "response.completed" &&
    raw.type !== "response.failed" &&
    raw.type !== "response.incomplete"
  ) {
    return undefined;
  }

  const responseId = isRecord(raw.response) ? nonEmptyString(raw.response.id) : undefined;
  if (!responseId) return undefined;

  if (raw.type === "response.in_progress") {
    return { type: "reasoning_phase_start", observedAt, attemptId, responseId };
  }

  return {
    type: "reasoning_phase_end",
    observedAt,
    attemptId,
    phaseEndReason: raw.type === "response.completed" ? "finish" : "failed",
    responseId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
