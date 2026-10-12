/**
 * 会话订阅失败的展示分级（UI 侧唯一解析入口）。
 *
 * CLI 侧冷恢复失败抛 `V4SubscribeSessionUnavailableError`
 * （cold-session-resume.ts），message 形如 `${detail} (${reasonCode})`；
 * store `failRecovery` 则会把裸 `fault.subscription.*` 码直接写进 lastError。
 * 这里两种载体都认，但只对 `fault.subscribe.*` 家族分级——其余一律按
 * 「与代理的连接已断开」的可重试档处理：重订阅走 start-if-needed，
 * 给用户一个手动入口仍然成立。
 *
 * 本文件只做纯字符串解析，不改 CLI error 格式、不持有任何状态。
 */

/** 订阅不可用会话的两档展示语义。 */
export type SessionSubscriptionErrorKind =
  /** 会话不存在/未持久化：重试注定再次失败，不给「重新连接」入口。 */
  | "sessionEnded"
  /** 连接类失败（resumeFailed / runtime 换代耗尽 / 传输断开）：可重试。 */
  | "disconnected";

export interface SessionSubscriptionErrorDisplay {
  kind: SessionSubscriptionErrorKind;
  /** 是否向用户展示「重新连接」入口。 */
  retryable: boolean;
  /** 解析出的 fault.subscribe.* reasonCode；无法解析时为 null。 */
  reasonCode: string | null;
}

/** 「正文 (reasonCode)」后缀形式 */
const SUFFIX_REASON_CODE_PATTERN = /\(fault\.subscribe\.([A-Za-z0-9._-]+)\)\s*$/;
/** 整条 message 就是 reasonCode（store failRecovery 的裸码形式） */
const STANDALONE_REASON_CODE_PATTERN = /^fault\.subscribe\.[A-Za-z0-9._-]+$/;
/** 会话已消失：store 无记录且宿主无持久化副本可恢复。 */
const SESSION_NOT_FOUND_REASON_CODE = "fault.subscribe.sessionNotFound";

/**
 * 从 store 的 lastError 提取 `fault.subscribe.*` reasonCode。
 *
 * 只认尾部括号后缀与整串裸码：reasonCode 出现在正文中段说明它只是错误叙述的
 * 一部分（例如把旧报错贴进新 detail），按无码处理更稳。
 */
export function parseSessionSubscriptionReasonCode(lastError: string | null): string | null {
  const trimmed = lastError?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const suffix = SUFFIX_REASON_CODE_PATTERN.exec(trimmed);
  if (suffix) return `fault.subscribe.${suffix[1]}`;
  if (STANDALONE_REASON_CODE_PATTERN.test(trimmed)) return trimmed;
  return null;
}

/** 订阅失败的 UI 展示分级：按钮可见性与标题选择都只读这里。 */
export function resolveSessionSubscriptionErrorDisplay(
  lastError: string | null,
): SessionSubscriptionErrorDisplay {
  const reasonCode = parseSessionSubscriptionReasonCode(lastError);
  if (reasonCode === SESSION_NOT_FOUND_REASON_CODE) {
    return { kind: "sessionEnded", retryable: false, reasonCode };
  }
  // resumeFailed、runtime 换代耗尽（store 中文常量）、裸 fault.subscription.* 码
  // 与一切解析失败的传输类错误：重连仍有自愈可能，保留手动入口。
  return { kind: "disconnected", retryable: true, reasonCode };
}
