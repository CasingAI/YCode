import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  isConnectionClosedError,
  isDefinitelyUnsentCommandError,
  pendingCommandRegistry,
} from "@/v4/pendingCommandRegistry.js";

type SendCommand = (envelope: CommandEnvelope) => Promise<CommandAck>;

/** AskUserQuestion 弹窗和侧栏胶囊共用同一条幂等暂停命令。 */
export async function sendInteractionAutoResolutionSnooze(params: {
  sessionId: string;
  interactionId: string;
  sendCommand: SendCommand;
  source: "dialog" | "taskBadge";
  onCommandSettled?: (commandId: string) => void;
}): Promise<boolean> {
  const envelope = createCommandEnvelope({
    type: "snoozeInteractionAutoResolution",
    sessionId: params.sessionId,
    payload: { interactionId: params.interactionId },
  });
  pendingCommandRegistry.record(envelope);
  try {
    const ack = await params.sendCommand(envelope);
    pendingCommandRegistry.applyAck(envelope, ack);
    if (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop") {
      return true;
    }
    logger.warn("[v4-interaction] 暂停自动结束被拒绝", {
      interactionId: params.interactionId,
      source: params.source,
      status: ack.status,
      reasonCode: ack.reasonCode,
    });
    return false;
  } catch (error) {
    if (isDefinitelyUnsentCommandError(error)) {
      pendingCommandRegistry.settle(params.sessionId, envelope.commandId);
    } else if (isConnectionClosedError(error)) {
      pendingCommandRegistry.markTransportInterrupted(params.sessionId, envelope.commandId);
    }
    logger.error("[v4-interaction] 暂停自动结束失败", {
      interactionId: params.interactionId,
      source: params.source,
      error,
    });
    return false;
  } finally {
    params.onCommandSettled?.(envelope.commandId);
  }
}
