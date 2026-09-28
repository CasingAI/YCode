// 冷恢复补投列表构造：从 session_input 账本选出「时间线上应看得见、但转录里没有」
// 的孤儿用户输入，交给 core 在水合前统一升格。本文件只负责选行、恢复 intent、映射
// 附件与排序，不写转录——转录的唯一写入所有者是 core 的升格原语。
//
// 入选判据与 docs/specs/web-remote-command-recovery.md 的「历史捞取」段一致：
// 用户发送种类、非主动排队（判 requestedDelivery）、有正文、能解析命令号；
// 状态收已受理 / 重启清扫丢弃 / 回合逃逸与共享上下文失败，排除用户主动动作
// （user_cleared、user_removed、cancelled）与其它 failed 原因。
import type { SessionId, SessionInputRecord, SessionStorePort, TurnInputIntentMetadata } from "@zcode/contracts";
import type { RecoveredUserInput, TurnAttachment } from "@zcode/core";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp } from "../app/types.js";
import { mapAttachmentRefsToTurnAttachments } from "../zcode-protocol-v4/commands/attachment-refs.js";

/** failed 行只捞「连升格都没跑到」的两类逃逸原因；其余 failed 属于其它失败语义。 */
const RECOVERABLE_FAILED_REASONS = new Set([
  "fault.command.turnLifecycleEscaped",
  "shared_context_not_attachable",
]);

function requestedDeliveryOf(record: SessionInputRecord): string | null {
  // 判「用户点了什么」（requestedDelivery），不判可能被降级改写的实际投递：
  // 「插进当前这一轮」因附件降级成排队的用户并没有主动排队。
  for (const candidate of [
    record.payload.conversationInputIntent,
    record.payload.intent,
  ]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    const requested =
      entry.requestedDelivery ?? (entry.delivery as Record<string, unknown> | undefined)?.requested;
    if (typeof requested === "string" && requested.length > 0) return requested;
  }
  return null;
}

function sourceCommandIdOf(record: SessionInputRecord): string | null {
  for (const candidate of [
    record.payload.conversationInputIntent,
    record.payload.intent,
  ]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const sourceCommandId = (candidate as Record<string, unknown>).sourceCommandId;
    if (typeof sourceCommandId === "string" && sourceCommandId.length > 0) return sourceCommandId;
  }
  return null;
}

function isRecoverableStatus(record: SessionInputRecord): boolean {
  if (record.status === "admitted") return true;
  if (record.status === "discarded") {
    // 只捞重启清扫；user_cleared 是用户主动清空，不恢复。
    return record.statusReason === "session_resumed";
  }
  if (record.status === "failed") {
    return record.statusReason !== undefined && RECOVERABLE_FAILED_REASONS.has(record.statusReason);
  }
  return false;
}

function attachmentRefsOf(record: SessionInputRecord): AttachmentRef[] | undefined {
  const candidates = [
    record.payload.attachments,
    record.payload.intent && typeof record.payload.intent === "object"
      ? (record.payload.intent as Record<string, unknown>).attachmentRefs
      : undefined,
    record.payload.conversationInputIntent &&
      typeof record.payload.conversationInputIntent === "object"
      ? (record.payload.conversationInputIntent as Record<string, unknown>).attachments
      : undefined,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.filter(
        (item): item is AttachmentRef =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      );
    }
  }
  return undefined;
}

/**
 * 恢复账本行为 core 升格所需的 intent。优先取 runtime metadata（payload.intent 与
 * TurnInputIntentMetadata 同构）；fork 等只写 conversationInputIntent 的历史行做一次
 * 字段映射。关键身份字段缺失时返回 undefined，core 会再从 payload 解析命令号。
 */
function restoreIntent(record: SessionInputRecord): TurnInputIntentMetadata | undefined {
  const raw = record.payload.intent;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.sourceCommandId === "string" && candidate.sourceCommandId.length > 0) {
      return raw as TurnInputIntentMetadata;
    }
  }
  const conversation = record.payload.conversationInputIntent;
  if (conversation && typeof conversation === "object" && !Array.isArray(conversation)) {
    const entry = conversation as Record<string, unknown>;
    const sourceCommandId = entry.sourceCommandId;
    const queueItemId = entry.queueItemId;
    const delivery = entry.delivery as Record<string, unknown> | undefined;
    const order = entry.order as Record<string, unknown> | undefined;
    if (
      typeof sourceCommandId === "string" &&
      sourceCommandId.length > 0 &&
      typeof queueItemId === "string" &&
      delivery &&
      typeof delivery.requested === "string" &&
      typeof delivery.admitted === "string"
    ) {
      return {
        sourceCommandId,
        queueItemId,
        clientId: typeof entry.clientId === "string" ? entry.clientId : "cli",
        kind: entry.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
        ...(typeof entry.text === "string" ? { text: entry.text } : {}),
        admissionSeq: typeof order?.admissionSeq === "number" ? order.admissionSeq : 0,
        admittedAt: typeof entry.admittedAt === "number" ? entry.admittedAt : record.time.created,
        requestedDelivery: delivery.requested as TurnInputIntentMetadata["requestedDelivery"],
        admittedDelivery: delivery.admitted as TurnInputIntentMetadata["admittedDelivery"],
        ...(Array.isArray(entry.attachments) ? { attachmentRefs: entry.attachments as TurnInputIntentMetadata["attachmentRefs"] } : {}),
        ...(Array.isArray(entry.sharedContextRefs)
          ? { sharedContextRefs: entry.sharedContextRefs as TurnInputIntentMetadata["sharedContextRefs"] }
          : {}),
      };
    }
  }
  return undefined;
}

/**
 * 列出该会话可补投的孤儿用户输入，按账本创建时间升序——多条补投的历史顺序
 * 与发送顺序一致。附件引用经现有映射（失效引用只留元信息，core 解析失败即丢弃，
 * 只留正文）。纯读：不写任何账本或转录事实。
 */
export async function collectRecoverableUserInputs(
  app: ZCodeApp,
  store: SessionStorePort | undefined,
  sessionId: string,
): Promise<RecoveredUserInput[]> {
  if (!store?.listSessionInputs) return [];
  const records = await store.listSessionInputs({ sessionID: sessionId as SessionId });
  const selected: SessionInputRecord[] = [];
  for (const record of records) {
    // 只有 sendText 是用户消息；compact 是命令、sendGoalCommand 是目标指令，
    // createSession 首条输入在账本里就是 sendText，不做特殊排除。
    if (record.kind !== "sendText") continue;
    if (!isRecoverableStatus(record)) continue;
    if (typeof record.payload.text !== "string" || record.payload.text.length === 0) continue;
    if (requestedDeliveryOf(record) === "queue") continue;
    if (sourceCommandIdOf(record) === null) continue;
    selected.push(record);
  }
  selected.sort((a, b) => a.time.created - b.time.created);

  const results: RecoveredUserInput[] = [];
  for (const record of selected) {
    const refs = attachmentRefsOf(record);
    let attachments: TurnAttachment[] | undefined;
    try {
      attachments = await mapAttachmentRefsToTurnAttachments(app, refs);
    } catch {
      // 附件映射失败不挡正文补投：丢掉全部附件，只留字。
      attachments = undefined;
    }
    results.push({
      sessionInputId: record.id,
      text: record.payload.text,
      createdAt: record.time.created,
      ...(restoreIntent(record) ? { intent: restoreIntent(record) } : {}),
      ...(attachments ? { attachments } : {}),
    });
  }
  return results;
}
