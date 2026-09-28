import type { MessageWithParts, SessionId, SessionStorePort } from "@zcode/contracts";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { PersistentCommandFactSource } from "./persistent-command-index.js";
import { isRecoverableUserInputRecord, sourceCommandIdOfSessionInput } from "./session-input-facts.js";

const V4_COMMAND_FACT_SESSION_ENTRY = "v4/command_fact";

function commandAck(value: unknown): CommandAck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ack = value as Partial<CommandAck>;
  if (typeof ack.commandId !== "string" || ack.commandId.length === 0) return null;
  if (ack.status !== "accepted" && ack.status !== "rejected" && ack.status !== "failed") {
    return null;
  }
  if (typeof ack.revisionAtDecision !== "number") return null;
  return ack as CommandAck;
}

export async function loadPersistentCommandFacts(
  store: SessionStorePort,
  sessionId: SessionId,
  options: { discardAdmittedOnLoad?: boolean } = {},
): Promise<Partial<Record<PersistentCommandFactSource, CommandAck[]>>> {
  const [messages, entries, discardedInputs] = await Promise.all([
    store.messages({ sessionID: sessionId }),
    store.sessionEntries?.({ sessionID: sessionId, type: V4_COMMAND_FACT_SESSION_ENTRY }) ?? [],
    options.discardAdmittedOnLoad
      ? (store.listSessionInputs?.({ sessionID: sessionId }) ?? [])
      : Promise.all([
          store.listSessionInputs?.({ sessionID: sessionId, status: "discarded" }) ?? [],
          // cancelled 也是 durable terminal input fact：若这里只读 discarded，用户主动删除
          // 的 queue item 在 512 LRU 淘汰后会退成 unknown，并可能以同 commandId 再执行。
          store.listSessionInputs?.({ sessionID: sessionId, status: "cancelled" }) ?? [],
        ]).then(([discarded, cancelled]) => [...discarded, ...cancelled]),
  ]);
  const facts: Record<PersistentCommandFactSource, Map<string, CommandAck>> = {
    transcript: new Map(),
    timeline: new Map(),
    child: new Map(),
    discarded: new Map(),
  };

  for (const message of messages as MessageWithParts[]) {
    for (const part of message.parts) {
      if (part.type !== "timeline" || !part.sourceCommandId) continue;
      facts.timeline.set(part.sourceCommandId, {
        commandId: part.sourceCommandId,
        status: "accepted",
        revisionAtDecision: 0,
      });
    }
    const sourceCommandId = message.info.anchor?.sourceCommandId;
    if (!sourceCommandId || facts.transcript.has(sourceCommandId)) continue;
    facts.transcript.set(sourceCommandId, {
      commandId: sourceCommandId,
      status: "accepted",
      revisionAtDecision: 0,
    });
  }

  for (const entry of entries) {
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : null;
    const source = data?.source;
    const ack = commandAck(data?.ack);
    if ((source === "timeline" || source === "child") && ack) {
      facts[source].set(ack.commandId, ack);
    }
  }

  for (const record of discardedInputs) {
    let terminalStatus = record.status;
    let terminalReason = record.statusReason;
    if (record.status === "admitted" && options.discardAdmittedOnLoad) {
      // 可补投的已受理行不在查询期结算：它们要等会话冷恢复时补投进转录，
      // 这里结算掉会让对账变成「明确失败」，与「打开会话即补投」冲突。
      // 不进 discarded facts = 查询表现为 unknown（禁止重放），正是期望行为。
      if (isRecoverableUserInputRecord(record)) continue;
      await store.settleSessionInput?.({
        id: record.id,
        sessionID: sessionId,
        status: "discarded",
        reason: "session_resumed",
      });
      terminalStatus = "discarded";
      terminalReason = "session_resumed";
    }
    if (terminalStatus !== "discarded" && terminalStatus !== "cancelled") {
      continue;
    }
    const sourceCommandId = sourceCommandIdOfSessionInput(record);
    if (!sourceCommandId) continue;
    const discardedOnRestart =
      terminalStatus === "discarded" && terminalReason === "session_resumed";
    const cancelledReasonCode =
      terminalReason?.startsWith("fault.") ||
      terminalReason?.startsWith("proto.") ||
      terminalReason?.startsWith("guard.")
        ? terminalReason
        : "fault.command.inputCancelled";
    facts.discarded.set(sourceCommandId, {
      commandId: sourceCommandId,
      status: "failed",
      reasonCode: discardedOnRestart
        ? "fault.command.inputDiscardedOnRestart"
        : cancelledReasonCode,
      message: discardedOnRestart
        ? "Input was discarded when the CLI restarted; confirm before resending."
        : "Input was cancelled before it entered the transcript.",
      revisionAtDecision: 0,
      ...(discardedOnRestart
        ? {
            // 旧 query 丢掉了 session_input.delivery，renderer 只能把所有
            // restart discard 当成可重发丢失；queue/guide 实际只属于旧 runtime。
            result: { type: "inputDisposition" as const, delivery: record.delivery },
          }
        : {}),
    });
  }

  return Object.fromEntries(
    Object.entries(facts).map(([source, values]) => [source, [...values.values()]]),
  ) as Partial<Record<PersistentCommandFactSource, CommandAck[]>>;
}

export async function savePersistentCommandFact(
  store: SessionStorePort,
  sessionId: SessionId,
  source: Extract<PersistentCommandFactSource, "timeline" | "child">,
  ack: CommandAck,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (!store.saveSessionEntry) throw new Error("fault.command.persistentFactStoreUnavailable");
  const now = Date.now();
  await store.saveSessionEntry({
    id: `v4_command_fact:${source}:${ack.commandId}`,
    sessionID: sessionId,
    type: V4_COMMAND_FACT_SESSION_ENTRY,
    time: { created: now, updated: now },
    data: { source, ack, ...(metadata ? { metadata } : {}) },
  });
}
