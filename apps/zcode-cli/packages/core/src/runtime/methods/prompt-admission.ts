import { createChildTraceContext, createQueryId, createTurnId } from "../deps.js";
import type { QueryId, TurnInputIntentMetadata } from "../deps.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { unlockUnattendedExecutionForHumanInput } from "../unattended-execution-lock.js";
import type {
  ActiveTurnStartReservation,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  TurnResult,
} from "../types.js";

/**
 * 每个 AgentRuntime 自己完成 prompt 的 admission：检查 busy 边界、同步建立 reservation、
 * 在接纳 commit 之后解锁，最后把 command 放进该 runtime 的 FIFO。Bootstrap 不应把这些
 * 步骤拆开，否则预留与解锁之间的 await 窗口会破坏单 turn 保证和解锁顺序。
 */
export async function admitPrompt(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: Parameters<AgentRuntimeInternal["executeTurn"]>[1],
  options?: PromptAdmissionOptions,
): Promise<PromptAdmissionReceipt> {
  const promotionLeaseOnly =
    options?.requireIdle === true &&
    this.foregroundPromotionLease !== undefined &&
    this.activeForegroundExecution === undefined &&
    this.runtimeCommandDrainActive === false &&
    this.runtimeCommandQueue.hasPending() === false &&
    this.activeTurn === undefined &&
    this.activeTurnStartReservation === undefined;
  const busy = this.hasActiveOrQueuedTurnWork() && !promotionLeaseOnly;
  if (busy) {
    if (options?.requireIdle === true) {
      return {
        activeTurnId: this.activeTurn?.turnId,
        kind: "rejected",
        reason: this.activeTurn ? "turn_not_steerable" : "no_active_turn",
      };
    }

    // 「仅本轮」声明（命令绑定着色）不能 steer 进正在跑的 turn：那条路径会在
    // 旧 turn 的模型步里续写，切过去的模型会与声明的轮次边界分叉。也不能直接拒单——
    // 那会把「静默不生效」变成「发不出去」。改为整条入队，声明随 intent 冻结，
    // 提升时由 queue handler 原样带回（与 compact 的入队分支同一形状）。
    const carriesExecutionScope = options?.modelExecution?.selectionScope === "execution";
    const activeTurn = this.activeTurn;
    const canSteer =
      !carriesExecutionScope &&
      attachments === undefined &&
      activeTurn?.steerable === true &&
      (options?.queueDelivery === "guide" ||
        options?.delivery === "auto" ||
        options?.delivery === "steer_active_turn") &&
      options?.queueDelivery !== "queue";
    if (canSteer) {
      const delivery = options?.queueDelivery === "guide" ? "guide" : undefined;
      return await this.steerTurn({
        commandKind: options?.commandKind,
        delivery,
        expectedTurnId: options?.expectedTurnId,
        input,
        inputPresentation:
          options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
        inputId: options?.inputId,
        intent: admissionIntent(options?.intent, delivery ?? "queue", options?.modelExecution),
        queryId: options?.queryId,
        toolDisallowlist: options?.toolDisallowlist,
        traceContext: options?.traceContext,
        unlocksUnattendedModeSwitch: options?.unlocksUnattendedModeSwitch,
        ...(options?.automationId ? { automationId: options.automationId } : {}),
        ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
      });
    }

    // 带声明的输入不能走 guide：guide 在当前 turn 的模型步里消费，模型已在跑，
    // 换不成绑定模型。强制 queue，让提升时的 startPromptTurn 用冻结的选择开新轮。
    const delivery =
      !carriesExecutionScope && options?.queueDelivery === "guide" && attachments === undefined
        ? "guide"
        : "queue";
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options?.commandKind,
      delivery,
      input,
      inputPresentation:
        options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
      inputId: options?.inputId,
      intent: admissionIntent(options?.intent, delivery, options?.modelExecution),
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext,
      unlocksUnattendedModeSwitch: options?.unlocksUnattendedModeSwitch,
      ...(options?.automationId ? { automationId: options.automationId } : {}),
      ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
    });
  }

  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  // 人工接纳计数必须在第一个 await 之前捕获；自动化 turn 以它为基线，启动窗口内
  // 已经 commit 的人工消息不会在本 turn 上锁时被覆盖。
  const unattendedHumanInputEpochAtAdmission = this.unattendedHumanInputEpoch;
  const turnId = createTurnId();
  const turnTraceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    queryId,
    sessionId: this.sessionId,
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  // 预留必须同步建立，否则两个 admission 都能看到空闲；预留成功才进入解锁写盘，
  // 写盘失败释放预留并让本次输入失败，不留下「已解锁但没接纳」的半程状态。
  // 已取消的输入不会进入队列，不能触发解锁；取消判定沿用 runtime-command-submit
  // 的 abortSignal 语义。
  this.reserveTurnStart(turnId, turnTraceContext, "regular");
  if (options?.abortSignal?.aborted !== true) {
    try {
      await unlockUnattendedExecutionForHumanInput(this, {
        unlocksUnattendedModeSwitch: options?.unlocksUnattendedModeSwitch,
        queryId,
        ...(options?.automationId ? { automationId: options.automationId } : {}),
        ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
      });
    } catch (error) {
      this.releaseTurnStart(turnId);
      throw error;
    }
  }
  const reservation: ActiveTurnStartReservation = {
    kind: "regular",
    traceContext: turnTraceContext,
    turnId,
    unattendedHumanInputEpochAtAdmission,
  };

  const executeOptions = options as ExecuteTurnOptions | undefined;
  const completion = enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    onCommandCancelled: () => this.releaseTurnStart(turnId),
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options: {
        ...executeOptions,
        queryId,
        traceContext: options?.traceContext ?? this.rootTraceContext,
      },
      priority: "next",
      reject,
      resolve,
      startReservation: reservation,
      traceContext: turnTraceContext,
    }),
  });
  // admission 已经完成；执行失败由现有 turn 事件/调用方消费，不制造 unhandled rejection。
  void completion.catch(() => undefined);
  return { completion, kind: "started", turnId };
}

function admissionIntent(
  intent: TurnInputIntentMetadata | undefined,
  admittedDelivery: "guide" | "queue",
  modelExecution?: PromptAdmissionOptions["modelExecution"],
): TurnInputIntentMetadata | undefined {
  if (!intent) return undefined;
  return {
    ...intent,
    admittedDelivery,
    // 声明随 intent 冻结：入队时写一次，提升时由 queue handler 读回，不在两处
    // 各自推导（否则设置变更会把插入时的模型当成用户改过的选择）。
    ...(modelExecution?.selectionScope === "execution"
      ? { modelExecution: { selectionScope: "execution" as const } }
      : {}),
  };
}
