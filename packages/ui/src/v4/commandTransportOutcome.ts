import {
  isConnectionClosedError,
  isDefinitelyUnsentCommandError,
} from "@/v4/pendingCommandRegistry.js";

export type CommandTransportOutcome = "outcomeUnknown" | "notSent";

/**
 * 发送失败的对外结局只有两种：已上送但 ACK 丢失（结果未知）、上行前就被拒绝（未发送）。
 * 未发送的错误同样带 ConnectionClosed 身份，判定必须让位于 not-sent，否则断线期用户会
 * 看到「结果未知」这种误导性提示。这里与 pending 账本共用同一套判定，优先级只有一处。
 */
export function toCommandTransportOutcomeError(
  error: unknown,
  format: (outcome: CommandTransportOutcome) => string,
): Error | null {
  const outcome: CommandTransportOutcome | null = isDefinitelyUnsentCommandError(error)
    ? "notSent"
    : isConnectionClosedError(error)
      ? "outcomeUnknown"
      : null;
  if (!outcome) return null;
  const outcomeError = new Error(format(outcome));
  outcomeError.name = outcome === "outcomeUnknown" ? "ConnectionClosed" : "ChannelClientDisposed";
  return outcomeError;
}
