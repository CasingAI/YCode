import type { ModelStreamEvent } from "../deps.js";

export interface ResponsesThinkingPhase {
  assistantResponseId?: string;
  source: "openai-responses";
  attemptId: string;
  responseId?: string;
  endedAt?: number;
  endReason?: "text" | "tool" | "finish" | "failed" | "cancelled" | "interrupted";
  startedAt: number;
}

/** 每次 model invocation 独立状态：只接受首次真实 start，首次 close 后不可延长。 */
export class ResponsesThinkingPhaseState {
  private readonly phasesByAttempt = new Map<string, ResponsesThinkingPhase>();
  private currentAttemptId?: string;

  apply(event: ModelStreamEvent): ResponsesThinkingPhase | undefined {
    if (event.type === "reasoning_phase_start") {
      const existing = this.phasesByAttempt.get(event.attemptId);
      if (existing) {
        this.currentAttemptId = event.attemptId;
        return existing;
      }
      const phase: ResponsesThinkingPhase = {
        source: "openai-responses",
        attemptId: event.attemptId,
        startedAt: event.observedAt,
        ...(event.responseId
          ? { assistantResponseId: event.responseId, responseId: event.responseId }
          : {}),
      };
      this.phasesByAttempt.set(event.attemptId, phase);
      this.currentAttemptId = event.attemptId;
      return phase;
    }
    if (
      event.type !== "reasoning_phase_end" ||
      !this.phasesByAttempt.has(event.attemptId)
    ) {
      return this.snapshot();
    }
    const phase = this.phasesByAttempt.get(event.attemptId)!;
    if (
      phase.endedAt !== undefined ||
      (event.responseId !== undefined &&
        phase.responseId !== undefined &&
        event.responseId !== phase.responseId)
    ) return phase;
    const closed = {
      ...phase,
      endedAt: Math.max(phase.startedAt, event.observedAt),
      endReason: event.phaseEndReason ?? "finish",
    };
    this.phasesByAttempt.set(event.attemptId, closed);
    return closed;
  }

  close(
    endedAt: number,
    reason: ResponsesThinkingPhase["endReason"],
    attemptId?: string,
  ): ResponsesThinkingPhase | undefined {
    const phase = attemptId
      ? this.phasesByAttempt.get(attemptId)
      : this.snapshot();
    if (attemptId && this.currentAttemptId !== attemptId) return phase;
    if (!phase || phase.endedAt !== undefined) return phase;
    const closed = { ...phase, endedAt: Math.max(phase.startedAt, endedAt), endReason: reason };
    this.phasesByAttempt.set(phase.attemptId, closed);
    return closed;
  }

  snapshot(attemptId?: string): ResponsesThinkingPhase | undefined {
    return attemptId
      ? this.phasesByAttempt.get(attemptId)
      : this.currentAttemptId
        ? this.phasesByAttempt.get(this.currentAttemptId)
        : undefined;
  }
}

