import type { SessionInputRecord } from "@zcode/contracts";

/**
 * 账本行 → 提交方命令号。
 *
 * 两个字段名并存是历史事实：`conversationInputIntent` 是权威写入格式，
 * `intent` 是更早的 runtime metadata（`updateSessionInputs` 仍在同步维护）。
 * 二者都带 `sourceCommandId`，取到即可——它是「同一个用户意图」的稳定身份，
 * 用来把账本事实与发起端的本地账本条目对齐。
 *
 * 解析不出的行不是客户端输入：steer 记账的 id 可能是 `pending_<turnId>_<seq>`
 * （`createPendingInputId`），行 id 本身不承载命令号，按前缀反解会错位。
 */
export function sourceCommandIdOfSessionInput(record: SessionInputRecord): string | null {
  for (const candidate of [record.payload.conversationInputIntent, record.payload.intent]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const sourceCommandId = (candidate as Record<string, unknown>).sourceCommandId;
    if (typeof sourceCommandId === "string" && sourceCommandId.length > 0) return sourceCommandId;
  }
  return null;
}

/**
 * 用户当时点的投递方式（requestedDelivery），不是可能被降级改写的实际投递。
 * 解析不出返回 null：这类行无法证明「用户主动排队」，按保守值视为可补投。
 */
export function requestedDeliveryOfSessionInput(record: SessionInputRecord): string | null {
  for (const candidate of [record.payload.conversationInputIntent, record.payload.intent]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    const requested =
      entry.requestedDelivery ?? (entry.delivery as Record<string, unknown> | undefined)?.requested;
    if (typeof requested === "string" && requested.length > 0) return requested;
  }
  return null;
}

/**
 * 「可补投」判据：用户发送种类、非主动排队（requestedDelivery 判「用户点了什么」）、
 * 有正文、能解析出命令号。查询期让路与重启清扫共用——满足者不结算，等会话冷恢复
 * 时由 core 升格进转录；不满足者（主动排队、命令、无正文、内部注入）按旧规则处理。
 */
export function isRecoverableUserInputRecord(record: SessionInputRecord): boolean {
  if (record.kind !== "sendText") return false;
  if (typeof record.payload.text !== "string" || record.payload.text.length === 0) return false;
  if (sourceCommandIdOfSessionInput(record) === null) return false;
  return requestedDeliveryOfSessionInput(record) !== "queue";
}
