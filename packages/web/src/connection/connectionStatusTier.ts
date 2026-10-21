/**
 * 连接状态条的阶段判定。
 *
 * 当前动作以连接管理器发布的状态和重试截止时间为准；累计失败次数和断线总时长
 * 不能替代「正在等」或「正在连接」这两个事实。
 */

import type { WebSocketConnectionSnapshot } from "@zcode/client";

/** 断线后先静默这么久，期间仍在等待且恢复则不渲染，避免瞬时抖动闪横幅。 */
export const BLIP_GRACE_MS = 800;

/** 恢复提示只闪这么久就整体消失，不在页面上留痕。 */
export const RECOVERED_FLASH_MS = 800;

export type ConnectionTier =
  /** 不渲染任何东西。 */
  | "hidden"
  /** 首次连接中。 */
  | "connecting"
  /** 已经发起重连、正在等握手结果。 */
  | "recovering"
  /** 下一次重试有明确的未来截止时间，带倒计时。 */
  | "waiting"
  /** 刚恢复，闪一下就撤。 */
  | "restored";

export interface ConnectionTierInput {
  readonly status: WebSocketConnectionSnapshot["status"];
  readonly disconnectedAt: number | null;
  readonly nextRetryAt: number | null;
  readonly now: number;
}

export interface ConnectionTierResult {
  readonly tier: ConnectionTier;
  /** 剩余整秒；仅在等待阶段用于文案。 */
  readonly seconds: number;
  /** 等待阶段才展示剩余时间线条。 */
  readonly showProgress: boolean;
  /** 等待阶段允许跳过退避；进入连接尝试后立即撤下。 */
  readonly showRetryAction: boolean;
}

function remainingSeconds(nextRetryAt: number, now: number): number {
  return Math.max(1, Math.ceil((nextRetryAt - now) / 1_000));
}

export function resolveConnectionTier(input: ConnectionTierInput): ConnectionTierResult {
  const { status, disconnectedAt, nextRetryAt, now } = input;

  if (status === "closed")
    return { tier: "hidden", seconds: 1, showProgress: false, showRetryAction: false };
  if (status === "connected")
    return { tier: "restored", seconds: 1, showProgress: false, showRetryAction: false };
  if (status === "connecting")
    return { tier: "connecting", seconds: 1, showProgress: false, showRetryAction: false };

  // 修复依据：截止时间为空或已到期时，连接管理器已派发当前重试；不能继续展示旧倒计时。
  if (nextRetryAt === null || nextRetryAt <= now) {
    return { tier: "recovering", seconds: 1, showProgress: false, showRetryAction: false };
  }

  const disconnectedFor = disconnectedAt === null ? null : now - disconnectedAt;
  if (disconnectedFor !== null && disconnectedFor < BLIP_GRACE_MS) {
    return { tier: "hidden", seconds: 1, showProgress: false, showRetryAction: false };
  }

  return {
    tier: "waiting",
    seconds: remainingSeconds(nextRetryAt, now),
    showProgress: true,
    showRetryAction: true,
  };
}
