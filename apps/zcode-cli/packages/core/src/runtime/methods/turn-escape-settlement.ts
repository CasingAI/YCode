// 回合逃逸后的账本收口：turn 生命周期结束后兜底终结仍挂在 admitted 的输入行。
//
// 根因：sendText 的 handler 在 startPromptTurn 返回后立刻 ACK，并不等待 turn 完成，
// 所以网关命令 promise 的 finally 兜底在 turn 抛错前就已按 accepted 走完，接不住 turn
// 后的异常；prompt-turn.ts 的 catch 也只记日志。账本若不在这里兜底终结，该行会永久
// 停在 admitted 并占住 session FIFO，此后所有用户输入静默卡死。
//
// 兜底的第一选择是补投升格而不是结算失败：时间线看得见的输入必须进转录。
// 已 promoted（成功路径再跑一次）是空操作；升格本身失败才退回结算 failed。
import { traceContextToLogContext } from "../deps.js";
import type { MessageId, TraceContext, TurnId, TurnInputIntentMetadata } from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export interface TurnEscapeSettlementInput {
  /** 账本行 id（queueItemId）。 */
  sessionInputId: string;
  /** 本回合的用户正文（与主路径 persistUserPrompt 一致）。 */
  text: string;
  /** 主路径已把正文放进内存历史（addEntries 成功但落库失败的逃逸）：补投只写库，不再灌内存。 */
  userPromptHydratedIntoHistory: boolean;
  /** 本回合已分配的 user messageId，缺省由升格原语新生成。 */
  userMessageId?: MessageId;
  /** 本回合已解析的附件，原样复用；逃逸发生在解析之前时原语从账本恢复、附件只留字。 */
  resolvedAttachments?: ResolvedTurnAttachment[];
  intent?: TurnInputIntentMetadata;
  turnId: TurnId;
  traceContext: TraceContext;
}

export interface TurnEscapeSettlementOptions {
  /** 子 agent 消息等内部注入（skipInputRecord / model-only）不进用户转录，按旧规则结算。 */
  skipInputRecord?: boolean;
  inputVisibility?: string;
}

export async function settleTurnEscapedSessionInput(
  this: AgentRuntimeInternal,
  input: TurnEscapeSettlementInput,
  options?: TurnEscapeSettlementOptions,
): Promise<void> {
  if (options?.skipInputRecord !== true && options?.inputVisibility !== "model-only") {
    try {
      const promoted = await this.promoteOrphanedUserInput({
        sessionInputId: input.sessionInputId,
        // createdAt 不传，原语用账本 time.created 落回原发送位置。
        text: input.text,
        ...(input.userMessageId ? { messageId: input.userMessageId } : {}),
        ...(input.resolvedAttachments
          ? { resolvedAttachments: input.resolvedAttachments }
          : {}),
        ...(input.intent ? { intent: input.intent } : {}),
        // 正文已进过内存历史时只补库：再 hydrate 会让 live 会话的模型上下文
        // 读到两份同一正文，而时间线投影只有一条（界面看不出）。
        hydrateIntoHistory: !input.userPromptHydratedIntoHistory,
        traceContext: input.traceContext,
      });
      if (promoted.status === "promoted" || promoted.status === "duplicate") {
        this.logger?.info("Turn-escaped session input promoted into transcript", {
          ...traceContextToLogContext(input.traceContext),
          event: "session_input.turn_escape_promoted",
          messageId: promoted.messageId,
          module: "core.runtime",
          sessionInputId: input.sessionInputId,
          turnId: String(input.turnId),
        });
      }
    } catch (error) {
      this.logger?.warn("Failed to promote turn-escaped session input; settling failed", {
        ...traceContextToLogContext(input.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.turn_escape_promote_failed",
        module: "core.runtime",
        sessionInputId: input.sessionInputId,
        turnId: String(input.turnId),
      });
      try {
        await this.sessionStore?.settleSessionInput?.({
          id: input.sessionInputId,
          sessionID: this.sessionId,
          status: "failed",
          reason: "fault.command.turnLifecycleEscaped",
        });
      } catch (settleError) {
        // 收口是善后动作，失败不能反过来覆盖已经完成/失败的主 turn。
        this.logger?.warn("Failed to settle session input after turn lifecycle", {
          error: settleError instanceof Error ? settleError.message : String(settleError),
          event: "session_input.settle_failed",
          module: "core.runtime",
          sessionInputId: input.sessionInputId,
          turnId: String(input.turnId),
        });
      }
    }
    return;
  }
  if (this.sessionStore?.settleSessionInput) {
    try {
      await this.sessionStore.settleSessionInput({
        id: input.sessionInputId,
        sessionID: this.sessionId,
        status: "failed",
        reason: "fault.command.turnLifecycleEscaped",
      });
    } catch (error) {
      // 收口是善后动作，失败不能反过来覆盖已经完成/失败的主 turn。
      this.logger?.warn("Failed to settle session input after turn lifecycle", {
        error: error instanceof Error ? error.message : String(error),
        event: "session_input.settle_failed",
        module: "core.runtime",
        sessionInputId: input.sessionInputId,
        turnId: String(input.turnId),
      });
    }
  }
}
