import type {
  CommandAck,
  CommandEnvelope,
  PendingInteraction,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import {
  isPlanApprovalPendingSummary,
  isPlanApprovalUserInputRequest,
} from "@/lib/planApproval.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  isConnectionClosedError,
  isDefinitelyUnsentCommandError,
  pendingCommandRegistry,
} from "@/v4/pendingCommandRegistry.js";

type SendCommand = (envelope: CommandEnvelope) => Promise<CommandAck>;

const PLAN_APPROVAL_ENVELOPE_TTL_MS = 24 * 60 * 60 * 1_000;
const planApprovalEnvelopes = new Map<string, { envelope: CommandEnvelope; expiresAt: number }>();

function planApprovalKey(sessionId: string, interactionId: string): string {
  return `${sessionId}\u0000${interactionId}`;
}

/**
 * 取（必要时创建）这次拒绝的命令信封。
 *
 * 跨 Root 代际复用同一 commandId 是刻意的：上一次尝试可能已经到达 runtime，
 * 换新 ID 重发会丢掉幂等对账的机会，让「同一 interaction 被拒绝两次」变成
 * 无法判定。只有确定没送达（{@link PlanApprovalDeclineOutcome} 的 `unsent`）
 * 才允许调用 {@link clearPlanApprovalEnvelope} 丢掉它。
 */
export function getPlanApprovalEnvelope(sessionId: string, interactionId: string): CommandEnvelope {
  const now = Date.now();
  for (const [key, value] of planApprovalEnvelopes) {
    if (value.expiresAt <= now) planApprovalEnvelopes.delete(key);
  }
  const key = planApprovalKey(sessionId, interactionId);
  const existing = planApprovalEnvelopes.get(key);
  if (existing) return existing.envelope;
  const envelope = createCommandEnvelope({
    type: "resolveInteraction",
    sessionId,
    payload: { interactionId, answer: { action: "decline" } },
  });
  planApprovalEnvelopes.set(key, {
    envelope,
    expiresAt: now + PLAN_APPROVAL_ENVELOPE_TTL_MS,
  });
  return envelope;
}

/** 丢弃缓存的信封，下次取时用新 commandId。只在确定没送达时调用。 */
export function clearPlanApprovalEnvelope(sessionId: string, interactionId: string): void {
  planApprovalEnvelopes.delete(planApprovalKey(sessionId, interactionId));
}

/**
 * 一次 decline 尝试的投递结果。三态而不是布尔，因为「确定送达」「确定没送达」
 * 「不知道」对重试策略的含义完全不同：前两者可以换新 commandId 重发，
 * 只有「不知道」必须沿用同一 commandId 走幂等对账。
 */
export type PlanApprovalDeclineOutcome =
  /** runtime 已接收（accepted/duplicate/noop），无需再发。 */
  | "delivered"
  /** 确定没送达：命令未到 transport，或 runtime 明确拒绝。换新 commandId 可安全重发。 */
  | "unsent"
  /** 结果未知：连接在途上断掉，命令可能已到达。必须沿用同一 commandId。 */
  | "unknown";
export interface PlanApprovalDeclineAttempt {
  commandId: string;
  outcome: PlanApprovalDeclineOutcome;
}

export interface PlanApprovalDeclineSettled {
  /** 是否保留「已拒绝过」标记。false 表示允许下一次权威信号再次尝试。 */
  keepDeclinedMarker: boolean;
  /** 是否丢弃缓存的命令信封（连带换新 commandId）。 */
  clearEnvelope: boolean;
}

/**
 * 投递结果 → 重试状态。
 *
 * `unsent` 必须移出去重标记：命令确实没到 runtime，留着标记就等于把
 * 「decline 已经发出」当成既成事实，而这个前提在传输失败时不成立。
 * 它也必须清掉信封——没送达的命令换新 commandId 重发不会破坏幂等。
 *
 * `unknown` 反过来：标记与信封都要留，否则重试会换一个 runtime 可能已经
 * 见过的 commandId，丢掉幂等对账的机会。
 */
export function planApprovalDeclineSettledState(
  attempt: PlanApprovalDeclineAttempt,
): PlanApprovalDeclineSettled {
  switch (attempt.outcome) {
    case "delivered":
      return { keepDeclinedMarker: true, clearEnvelope: true };
    case "unsent":
      return { keepDeclinedMarker: false, clearEnvelope: true };
    case "unknown":
      return { keepDeclinedMarker: true, clearEnvelope: false };
  }
}

/** 是否该再发一次 decline。effect 的唯一闸门，抽出以便单测直接驱动重试状态机。 */
export function shouldAttemptPlanApprovalDecline(params: {
  declinedIds: ReadonlySet<string>;
  planApprovalInteractionId: string | null;
}): boolean {
  if (!params.planApprovalInteractionId) return false;
  return !params.declinedIds.has(params.planApprovalInteractionId);
}

/**
 * 在全部待结算交互里找第一个计划批准。
 *
 * 不复用「弹窗渲染用的首个可渲染交互」：排在首位的那种交互在 runtime 侧
 * 往往不可回答（turn 已阻塞在 ExitPlanMode 审批），若只认首位，计划批准
 * 会永远轮不到被拒绝，列表行就此永久停在转圈加「等待确认」。
 */
export function findPlanApprovalDeclineTarget(
  pendingInteractions: readonly PendingInteraction[] | undefined,
): string | null {
  if (!pendingInteractions) return null;
  for (const interaction of pendingInteractions) {
    if (
      interaction.payload.kind === "userInput" &&
      isPlanApprovalUserInputRequest(interaction.payload)
    ) {
      return interaction.interactionId;
    }
  }
  return null;
}

/** 「已拒绝」标记的去重键。与信封缓存同键，避免两处各写一套拼接规则。 */
export function planApprovalDeclineKey(sessionId: string, interactionId: string): string {
  return planApprovalKey(sessionId, interactionId);
}

export interface PlanApprovalDeclineTarget {
  sessionId: string;
  interactionId: string;
}

/**
 * 从 sessions-index 摘要里挑出还没拒绝过的计划批准。
 *
 * 摘要只有 `pendingInteraction` 一条（见 `deriveSessionSummary` 的位次不变量），
 * 所以这里是**每个会话最多一个目标**；同一会话里排在计划批准之前的其他交互
 * 不会遮住它。摘要是 conflation 的产物，因此不按下标或顺序做任何假设，
 * 只按 `sessionId` 逐条判定。
 */
export function collectPlanApprovalDeclineTargets(
  sessions: readonly SessionSummary[],
  declinedKeys: ReadonlySet<string>,
): PlanApprovalDeclineTarget[] {
  const targets: PlanApprovalDeclineTarget[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const pending = session.pendingInteraction;
    if (!pending || !isPlanApprovalPendingSummary(pending)) continue;
    const key = planApprovalKey(session.sessionId, pending.interactionId);
    if (seen.has(key) || declinedKeys.has(key)) continue;
    seen.add(key);
    targets.push({
      sessionId: session.sessionId,
      interactionId: pending.interactionId,
    });
  }
  return targets;
}

/**
 * 发一次计划批准的静默拒绝。
 *
 * 与 {@link sendInteractionAutoResolutionSnooze} 同构：sendCommand 注入、
 * 不碰 ref 与模块级缓存，返回结构化结果让调用方决定重试状态。
 * 失败时本函数**不抛**——抛了调用方就得靠 catch 分支做决策，而三条失败
 * 路径（确定未发出 / 连接中断 / 其他）的重试语义各不相同，混在一个 catch 里
 * 正是这次缺陷的来源。
 */
export async function sendPlanApprovalDecline(params: {
  sessionId: string;
  interactionId: string;
  envelope: CommandEnvelope;
  sendCommand: SendCommand;
  onCommandSettled?: (commandId: string) => void;
}): Promise<PlanApprovalDeclineAttempt> {
  const { envelope } = params;
  pendingCommandRegistry.record(envelope);
  try {
    const ack = await params.sendCommand(envelope);
    pendingCommandRegistry.applyAck(envelope, ack);
    if (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop") {
      return { commandId: envelope.commandId, outcome: "delivered" };
    }
    logger.warn("[v4-interaction] 计划批准静默拒绝被拒", {
      interactionId: params.interactionId,
      status: ack.status,
      reasonCode: ack.reasonCode,
    });
    return { commandId: envelope.commandId, outcome: "unsent" };
  } catch (error) {
    if (isDefinitelyUnsentCommandError(error)) {
      pendingCommandRegistry.settle(params.sessionId, envelope.commandId);
      return { commandId: envelope.commandId, outcome: "unsent" };
    }
    if (isConnectionClosedError(error)) {
      pendingCommandRegistry.markTransportInterrupted(params.sessionId, envelope.commandId);
      return { commandId: envelope.commandId, outcome: "unknown" };
    }
    // 未分类的异常同样不能假定「没送到」：保留 registry 条目走对账。
    logger.error("[v4-interaction] 计划批准静默拒绝失败", {
      interactionId: params.interactionId,
      error,
    });
    return { commandId: envelope.commandId, outcome: "unknown" };
  } finally {
    params.onCommandSettled?.(envelope.commandId);
  }
}
