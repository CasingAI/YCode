/**
 * 连接状态条的分级判定。
 *
 * 从组件里抽成纯函数，是因为这套规则同时依赖「断开持续时长」「剩余等待时间」
 * 和「是否已经断过线」三个输入，任何一处判错都会渲染出与事实相反的文案
 * （比如刚连上却提示「连接已恢复」还在旁边挂一个「立即重试」）。
 */

import type { WebSocketConnectionSnapshot } from "@zcode/client";

/** 断线后先静默这么久，期间恢复就完全不渲染，避免切后台那一瞬在对话上方闪条横幅。 */
export const BLIP_GRACE_MS = 800;

/** 恢复提示只闪这么久就整体消失，不在页面上留痕。 */
export const RECOVERED_FLASH_MS = 800;

/** 断开超过这么久就升级成需要用户介入的卡片。 */
export const ESCALATE_AFTER_MS = 15_000;

/** 判定恢复用的重复失败门槛。与 attempt 字段同源，但只用来判断「是不是又挂了」。 */
const REPEATED_FAILURE_ATTEMPT = 2;

export type ConnectionTier =
  /** 不渲染任何东西。 */
  | "hidden"
  /** 首次连接中。 */
  | "connecting"
  /** 已经发起重连、正在等握手结果，此刻没有剩余时间可报。 */
  | "recovering"
  /** 退避等待中，带倒计时。 */
  | "waiting"
  /** 同一次断线里已经失败过不止一次。 */
  | "unstable"
  /** 断开超过阈值，需要用户手动介入。 */
  | "stalled"
  /** 刚恢复，闪一下就撤。 */
  | "restored";

export interface ConnectionTierInput {
  readonly status: WebSocketConnectionSnapshot["status"];
  readonly attempt: number;
  readonly disconnectedAt: number | null;
  readonly nextRetryAt: number | null;
  readonly now: number;
}

export interface ConnectionTierResult {
  readonly tier: ConnectionTier;
  /** 剩余整秒，最少 1，避免出现「0 秒后自动重连」。 */
  readonly seconds: number;
  /**
   * 顶部进度条只表达「还要等多久」，所以只在退避等待态出现。
   * 正在连接时没有剩余时间可等，已恢复时没什么可等，两者都不挂。
   */
  readonly showProgress: boolean;
  /**
   * 重试按钮是「系统承认自己搞不定、需要用户介入」的信号，
   * 只与升级态卡片同时出现，不在自动恢复流程中常驻。
   */
  readonly showRetryAction: boolean;
}

function remainingSeconds(nextRetryAt: number | null, now: number): number {
  if (nextRetryAt === null) return 1;
  return Math.max(1, Math.ceil((nextRetryAt - now) / 1_000));
}

export function resolveConnectionTier(input: ConnectionTierInput): ConnectionTierResult {
  const { status, attempt, disconnectedAt, nextRetryAt, now } = input;

  if (status === "closed")
    return { tier: "hidden", seconds: 1, showProgress: false, showRetryAction: false };
  if (status === "connected")
    return { tier: "restored", seconds: 1, showProgress: false, showRetryAction: false };
  // connecting 必须有自己的分支：复用恢复态会渲染出与事实相反的「连接已恢复」。
  if (status === "connecting")
    return { tier: "connecting", seconds: 1, showProgress: false, showRetryAction: false };

  const disconnectedFor = disconnectedAt === null ? null : now - disconnectedAt;
  if (disconnectedFor !== null && disconnectedFor < BLIP_GRACE_MS) {
    return { tier: "hidden", seconds: 1, showProgress: false, showRetryAction: false };
  }

  const seconds = remainingSeconds(nextRetryAt, now);
  const showProgress = nextRetryAt !== null;

  if (disconnectedFor !== null && disconnectedFor >= ESCALATE_AFTER_MS) {
    return { tier: "stalled", seconds, showProgress, showRetryAction: true };
  }
  // 已经在建连、只是还没拿到握手结果：此时报「N 秒后自动重连」是假的，
  // 没有下一次重试定时器在跑，只能说正在恢复。
  if (nextRetryAt === null) {
    return { tier: "recovering", seconds, showProgress, showRetryAction: false };
  }
  if (attempt >= REPEATED_FAILURE_ATTEMPT) {
    return { tier: "unstable", seconds, showProgress, showRetryAction: false };
  }
  return { tier: "waiting", seconds, showProgress, showRetryAction: false };
}
