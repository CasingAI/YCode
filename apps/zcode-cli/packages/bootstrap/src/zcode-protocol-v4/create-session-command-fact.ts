import type { SessionStorePort } from "@zcode/contracts";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { queueItemIdForCommand } from "./command-inbox.js";
import { isRecoverableUserInputRecord } from "./session-input-facts.js";

/**
 * createSession 使用 global command bucket，但 firstInput 的 durable fact 落在新 session。
 * 通过全局唯一 queue item id 找回真实 session，闭合 ACK 丢失/CLI restart 的查重路径。
 */
export async function lookupGlobalCreateSessionCommand(
  store: SessionStorePort | undefined,
  commandId: string,
): Promise<CommandAck | null> {
  const record = await store?.getSessionInputById?.(queueItemIdForCommand(commandId));
  if (
    !record ||
    record.payload.sourceCommandType !== "createSession" ||
    (record.payload.conversationInputIntent as { sourceCommandId?: unknown } | undefined)
      ?.sourceCommandId !== commandId
  ) {
    return null;
  }
  if (record.status === "promoted") {
    return {
      commandId,
      status: "accepted",
      revisionAtDecision: 0,
      result: { type: "createSession", sessionId: String(record.sessionID) },
    };
  }
  if (record.status === "admitted") {
    // 首条输入仍可补投时不结算、不回失败：查询表现为未知（禁止重放），
    // 打开新会话触发冷恢复时由 core 补投进转录。主动排队仍按重启清扫结算，
    // 避免排队行永远占住新会话的串行入口。
    if (isRecoverableUserInputRecord(record)) {
      return null;
    }
    await store?.settleSessionInput?.({
      id: record.id,
      sessionID: record.sessionID,
      status: "discarded",
      reason: "session_resumed",
    });
    return {
      commandId,
      status: "failed",
      reasonCode: "fault.command.inputDiscardedOnRestart",
      message: "Input was discarded when the CLI restarted; confirm before resending.",
      revisionAtDecision: 0,
    };
  }
  const reasonCode =
    record.status === "discarded" && record.statusReason === "session_resumed"
      ? "fault.command.inputDiscardedOnRestart"
      : record.statusReason?.startsWith("fault.") ||
          record.statusReason?.startsWith("proto.") ||
          record.statusReason?.startsWith("guard.")
        ? record.statusReason
        : "fault.command.inputCancelled";
  return {
    commandId,
    status: "failed",
    reasonCode,
    revisionAtDecision: 0,
  };
}
