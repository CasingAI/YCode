// goal/compact 命令组：compact / sendGoalCommand / pauseGoal / resumeGoal。
// 语义自旧 server-operations compactSession/goalSession/continueGoalAfterChange 搬运，
// 决策逻辑（compact 去重 / active turn barrier / goal 续跑）直驱 core，不经旧协议 op。
//
// 与旧协议路径的映射（保真基线）：
// - compactSession（server-operations.ts:1805）→ compact
// - goalSession action:"set"（:1919，含重复 set 收敛 replace）→ sendGoalCommand
// - goalSession action:"resume"（:1980）→ resumeGoal
// - continueGoalAfterChange / runGoalContinuationInBackground（:2204-2269）→ 组内私有共用函数
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { SteerTurnOptions, SubmitPromptOptions } from "../../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../../zcode-protocol/session-residency.js";
import { inputIntentMetadata } from "../input-intent.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  applyHeldQueueDisposition,
  enqueueDeferredInputForBusyWork,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "./session-flow.js";

/** goal/compact 组的裁决拒绝（gateway 捕获后进 ACK failed，message 透传给客户端）。 */
export class V4GoalCompactRejectedError extends Error {
  constructor(
    readonly reasonCode:
      | "activeTurn"
      | "compactOperationLock"
      | "restoreWarning"
      | "guard.planGoalMutuallyExclusive"
      | "guard.readOnlyGoalMutuallyExclusive"
      | "emptyObjective",
    message: string,
  ) {
    super(message);
    this.name = "V4GoalCompactRejectedError";
  }
}

// 手动 compact 在后台 turn 真正登记前，下一条 command 已可能完成 admission。
// 仅看 runtime activeTurn 会留下一个极短的重复 compact 窗口；controller WeakSet 只补齐
// operation lock 的同步边界，不复制 queue 或 lifecycle 业务状态。
const manualCompactControllers = new WeakSet<AbortController>();

/**
 * compact：手动上下文压缩（v4 payload 可带可选的 instructions 摘要指令）。
 *
 * barrier 语义：
 * 1. running/goal verifier/goal continuation/tool work → typed compact intent 入 FIFO。
 * 2. held queue → 追加队尾，不绕过既有 future intent。
 * 3. running 或 queued compact 已存在 → compactOperationLock，禁止重复压缩。
 */
async function compact(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  // 输入框发送压缩时带来的模型选择与「仅本轮」声明（命令绑定默认，或用户改后的选择）。
  // 声明由发送端按插入锁定的着色快照判定；缺省 = 用会话模型并写回，执行侧不再推导。
  const payload = envelope.payload as CommandPayloadMap["compact"];
  const payloadModelSelection = payload?.modelSelection;
  const payloadModelExecution = payload?.modelExecution;
  // 用户跟在 /compact 后面的摘要指令（与模型绑定正交）：拼成 canonical 文本后
  // 走 core 文本链路（parseCompactCommand → buildCompactPrompt），与旧协议
  // session/compact 的 instructions 拼法一致。缺省（旧客户端）等价无参。
  const payloadInstructions = payload?.instructions?.trim() || undefined;
  const compactCommand = payloadInstructions ? `/compact ${payloadInstructions}` : "/compact";
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  const activeController = record.activeAbortController;
  if (
    activeTurn?.kind === "compact" ||
    (activeController ? manualCompactControllers.has(activeController) : false) ||
    host.hasQueueItemKind?.(record.app.sessionId, "compact")
  ) {
    host.logger?.info?.("v4 compact already running or queued, rejected", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
    throw new V4GoalCompactRejectedError(
      "compactOperationLock",
      "Compact is already running or queued",
    );
  }
  if (record.restoreWarning) {
    // 与 prompt-turn 相同的闸门：恢复失败的会话不能静默续写（含 compact turn）。
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }

  const routingMode = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  const busy = Boolean(record.activeAbortController) || Boolean(activeTurn);
  if (busy || routingMode === "enqueue" || routingMode === "guide" || routingMode === "choice") {
    // 队列 intent 带上模型选择：提升时经 queueItem 原样传回 startManualCompact，
    // 不能只在入队瞬间写过就丢。
    const intent = inputIntentMetadata(envelope, {
      requestedDelivery: "queue",
      text: compactCommand,
      ...(payloadModelSelection ? { modelSelection: payloadModelSelection } : {}),
      ...(payloadModelExecution
        ? { modelExecution: { selectionScope: "execution" as const } }
        : {}),
    });
    const queueOptions = {
      commandKind: "compact" as const,
      inputId: envelope.commandId,
      intent,
      queryId: envelope.commandId as NonNullable<SteerTurnOptions["queryId"]>,
    };
    if (await enqueueDeferredInputForBusyWork(record, compactCommand, queueOptions)) {
      return undefined;
    }
    const queued = await record.app.steerTurn(compactCommand, {
      ...queueOptions,
      delivery: "queue",
    });
    if (queued.kind === "rejected") {
      throw new V4InputAdmissionRejectedError(
        queued.reason === "input_too_large"
          ? "proto.payloadTooLarge"
          : queued.reason === "empty_input"
            ? "proto.invalidPayload"
            : "fault.command.inputRejected",
        `compact input queue rejected: ${queued.reason}`,
      );
    }
    return undefined;
  }

  await startManualCompact(
    host,
    record,
    envelope.commandId,
    undefined,
    inputIntentMetadata(envelope, {
      requestedDelivery: "startNow",
      text: compactCommand,
      ...(payloadModelSelection ? { modelSelection: payloadModelSelection } : {}),
      ...(payloadModelExecution
        ? { modelExecution: { selectionScope: "execution" as const } }
        : {}),
    }),
    compactCommand,
  );
  return undefined;
}

/** queue promotion 与直接命令共用唯一手动 compact 启动路径。 */
export async function startManualCompact(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  inputId: string,
  foregroundPromotionLeaseId?: string,
  intent?: SteerTurnOptions["intent"],
  compactCommand = "/compact",
): Promise<void> {
  if (record.restoreWarning) {
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }
  // 冷恢复后用户可能直接触发 /compact（不先经 sendText），compact 的后台模型请求
  // 同样需要模型就绪检查——钩子（见 types.ts）。
  await host.ensureModelReady?.(record);
  const abortController = new AbortController();
  // compact 的真实模型请求在后台执行，但 Stop 仍通过
  // record.activeAbortController 中断。不登记 controller，压缩中的请求会跑到自然结束。
  record.activeAbortController = abortController;
  manualCompactControllers.add(abortController);
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(host, record, {
      abortController,
      compactCommand,
      foregroundPromotionLeaseId,
      inputId,
      intent,
    }),
  ).catch(() => {
    // 后台 compact 的错误经事件流（CompactStarted/终态 marker）降级上报；兜底防 unhandled rejection。
  });
}

async function runCompactTurnInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    compactCommand: string;
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  let lifecycleStatus: "success" | "failed" | "cancelled" = "success";
  host.logger?.info?.("v4 background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt(params.compactCommand, {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
      ...(params.intent ? { intent: params.intent } : {}),
      // 「仅本轮」以发送端随 intent 声明的为准（队列提升已经原样带回），
      // 不再开跑时现读配置推导——那会把设置变更误判成「用户改过模型」。
      ...(params.intent?.modelExecution?.selectionScope === "execution"
        ? { modelExecution: { selectionScope: "execution" as const } }
        : {}),
    });
  } catch (error) {
    lifecycleStatus = params.abortController.signal.aborted ? "cancelled" : "failed";
    mutationReason =
      lifecycleStatus === "cancelled" ? "session_compact_cancelled" : "session_compact_failed";
    if ((host.getQueueLength?.(record.app.sessionId) ?? 0) > 0) {
      try {
        // queued compact 是 FIFO barrier；失败/Stop 后若继续 auto-drain，
        // 后续文本会越过用户显式维护意图。与普通 Stop 一致切为 held。
        await record.app.setQueueAutoDrain(false);
      } catch (holdError) {
        host.logger?.warn?.("v4 compact failed to hold following queue", {
          error: holdError instanceof Error ? holdError.message : String(holdError),
          inputId: params.inputId,
          sessionId: record.app.sessionId,
        });
      }
    }
    host.logger?.warn?.("v4 background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    manualCompactControllers.delete(params.abortController);
    if (record.activeAbortController === params.abortController) {
      // ready 边界（关键约束）：compact 结束后必须先释放 active lock 再广播；
      // 否则 queued prompt 或后续 /compact 会在 ready 边界短暂撞上旧 controller。
      record.activeAbortController = undefined;
    }
  }
  try {
    // compact 没有 user message，不能依赖 SessionInputPromoted 解 pin；无论 lifecycle
    // 成功/失败/取消，都用 timeline command fact 阻止重启后把已执行命令再次提示重放。
    await host.recordPersistentCommandFact?.(
      record.app.sessionId,
      "timeline",
      {
        commandId: params.inputId,
        status: "accepted",
        revisionAtDecision: 0,
      },
      { lifecycleStatus },
    );
  } catch (error) {
    // compact 已执行，不能因查重旁路写失败伪装为模型执行失败。
    host.logger?.warn?.("v4 compact persistent command fact failed", {
      commandId: params.inputId,
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
  }
  // 旧协议路径在此调 afterStateMutation → 用钩子等价替代（随旧广播删除）。
  await host.afterLegacyStateMutation?.(record, mutationReason);
}

/**
 * sendGoalCommand：设置/更新 goal（旧 goalSession action:"set"）。
 *
 * barrier 语义（自旧协议路径保真 + v4 队列补齐）：
 * 1. active turn → 入队为 sendGoalCommand：/goal 是目标状态写入，不是普通 prompt；
 *    运行中不能直接改 target，但也不能丢弃。队列项必须保留命令身份，等 ready 边界执行。
 * 2. 重复 set 收敛 replace 语义（关键约束）：输入框里的 `/goal 新目标` 是用户
 *    显式提交的新目标；已有目标时继续要求 replace 会让用户以为目标已变更但数据库仍保留
 *    旧目标。这里读到已有 target 就按替换路径处理（差异只体现在广播 reason）。
 */
async function sendGoalCommand(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendGoalCommand"];
  const record = requireRecord(host, envelope.sessionId);
  const objective = payload.text.trim();
  if (objective.length === 0) {
    throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
  }
  const submittedExecutionState = resolveSubmittedExecutionState(record, payload);
  // Goal 只能在 Agent 跑：自主循环要落盘，Plan / Ask 都跑不动。提交侧直接拒绝，
  // 不把载荷偷偷改成 yolo——否则协议直连就能绕过模式轴切档。
  if (submittedExecutionState.mode !== "yolo") {
    throwGoalModeConflict(submittedExecutionState.mode === "plan" ? "plan" : "ask");
  }
  const submissionIntent = (options: Parameters<typeof inputIntentMetadata>[1]) =>
    inputIntentMetadata(envelope, { ...options, ...submittedExecutionState });
  const routingMode = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  if (record.activeAbortController || routingMode === "enqueue" || routingMode === "guide") {
    // /goal 是目标控制命令，active turn 中不能直接写 target；
    // 但产品语义要求 running/compacting/goal verifier 可入队。busy projection 可能
    // 早于 controller 登记，因此同时消费 inputRouting；commandKind 保住控制命令身份，
    // 后续消费时走 sendGoalCommand，而不是普通 user prompt。
    const queuedText = goalCommandQueueText(payload.displayText, objective);
    if (
      await enqueueDeferredInputForBusyWork(record, queuedText, {
        commandKind: "sendGoalCommand",
        inputId: envelope.commandId,
        queryId: envelope.commandId as SteerTurnOptions["queryId"],
        intent: submissionIntent({ requestedDelivery: "queue", text: objective }),
      })
    ) {
      return undefined;
    }
    const queued = await record.app.steerTurn(queuedText, {
      commandKind: "sendGoalCommand",
      inputId: envelope.commandId,
      queryId: envelope.commandId as SteerTurnOptions["queryId"],
      intent: submissionIntent({ requestedDelivery: "queue", text: objective }),
    });
    if (queued.kind === "rejected") {
      throw new V4InputAdmissionRejectedError(
        queued.reason === "input_too_large"
          ? "proto.payloadTooLarge"
          : queued.reason === "empty_input"
            ? "proto.invalidPayload"
            : "fault.command.inputRejected",
        `goal input queue rejected: ${queued.reason}`,
      );
    }
    return undefined;
  }
  await applyGoalCommand(host, record, {
    delivery: "immediate",
    displayText: goalCommandQueueText(payload.displayText, objective),
    heldQueueDisposition: payload.heldQueueDisposition,
    expectedHeldQueueItemIds: payload.expectedHeldQueueItemIds,
    inputId: envelope.commandId,
    objective,
    intent: submissionIntent({ requestedDelivery: "startNow", text: objective }),
  });
  return undefined;
}

export async function applyGoalCommand(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    /**
     * 调用来源。`immediate` = sendGoalCommand 的立即分支（载荷带用户本次显式选择的档位），
     * `queue`/缺省 = 队列提升消费（档位是入队当时冻结的快照）。
     * 见 docs/specs/agent-mode-axis.md「档位有两份，消费时机决定谁说了算」。
     */
    delivery?: "immediate" | "queue";
    displayText?: string;
    heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
    expectedHeldQueueItemIds?: readonly string[];
    inputId: string;
    objective: string;
    foregroundPromotionLeaseId?: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  // held choice 裁决（同 sendText；sendGoalCommand）。
  await applyHeldQueueDisposition(
    host,
    record,
    params.heldQueueDisposition,
    params.expectedHeldQueueItemIds,
  );
  const replacesExistingGoal = Boolean(await record.app.readTarget());
  // 立即发送：本次提交档位是用户显式选择的事实，会话档还停在旧档时必须先把它落进会话。
  // 档位有两份（Composer 草稿档 vs 会话档），提交侧 resolveSubmittedExecutionState 已按载荷
  // 放行；若这里不落档，受限判定会读会话旧档（Ask）把用户刚发的 /goal 自我拒绝掉，
  // 表现为「发不出去」。落的是用户选的档、走的还是 setExecutionState 这一个写入点，
  // 所以不违反「Goal 不得偷偷改档」（那条约束的是改写用户没选的档位）。
  // 顺序固定：落档 → setTarget → continueGoalAfterChange。档已落但目标未写不回滚——
  // 回滚等于用一次失败抹掉一次正确操作，用户重发即可。
  if (params.delivery === "immediate") {
    await applyImmediateGoalMode(record, params.intent);
  }
  // 写目标之前必须确认会话此刻真的在 Agent。queue 里冻结的是入队当时的档位，
  // 轮到执行时用户可能已经切到 Plan / Ask；那一刻既不能落盘目标，也不允许由
  // Goal 命令把 runtime 升回 Agent 顶掉这次显式切档。
  const restrictedMode = intentRestrictedGoalMode(params.intent) ?? restrictedGoalMode(record);
  if (restrictedMode) {
    throwGoalModeConflict(restrictedMode);
  }
  await record.app.setTarget({
    ...(params.displayText ? { displayText: params.displayText } : {}),
    objective: params.objective,
    status: "active",
    ...(params.intent ? { intent: params.intent } : {}),
  });
  await continueGoalAfterChange(host, record, {
    foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
    inputId: params.inputId,
    intent: params.intent,
    reason: replacesExistingGoal ? "goal_replaced" : "goal_set",
  });
}

/**
 * 立即发送时把本次提交的档位写进会话（提交侧已拒绝受限档，这里只剩非受限档）。
 * 缺 intent.mode（协议直连未声明档位）时不猜——回落会话当前档，交由受限判定裁决。
 */
async function applyImmediateGoalMode(
  record: V4SessionRecordView,
  intent: SteerTurnOptions["intent"],
): Promise<void> {
  const submittedMode = intent?.mode;
  if (!submittedMode || intentRestrictedGoalMode(intent)) return;
  if (record.app.getMode?.() === submittedMode) return;
  await record.app.runtime.setExecutionState({ mode: submittedMode }, record.traceContext);
}

export { parseGoalObjectiveFromCommandText } from "./goal-command-objective.js";

/** 受限档：Goal 的自主循环要落盘，Plan / Ask 都跑不动。 */
type RestrictedGoalMode = "plan" | "ask";

/**
 * 当前会话档位是否让 Goal 无法运行。`mode` 是唯一真值（docs/specs/agent-mode-axis.md），
 * 派生的 getPlanEnabled / getReadOnlyEnabled 只在测试替身缺 mode 时兜底。
 * resumeGoal 与 applyGoalCommand 共用这一份判定，避免两处各解释一次档位。
 */
function restrictedGoalMode(record: V4SessionRecordView): RestrictedGoalMode | null {
  const mode = record.app.getMode?.();
  if (record.app.runtime?.getPlanEnabled?.() ?? mode === "plan") return "plan";
  return (record.app.runtime?.getReadOnlyEnabled?.() ?? mode === "readonly") ? "ask" : null;
}

/** 队列项冻结的是入队当时的档位：优先按 intent 判定，缺字段才回落到会话当前档位。 */
function intentRestrictedGoalMode(intent: SteerTurnOptions["intent"]): RestrictedGoalMode | null {
  if (!intent) return null;
  if (intent.planEnabled ?? intent.mode === "plan") return "plan";
  return (intent.readOnlyEnabled ?? intent.mode === "readonly") ? "ask" : null;
}

function throwGoalModeConflict(restrictedMode: RestrictedGoalMode): never {
  throw new V4GoalCompactRejectedError(
    restrictedMode === "plan"
      ? "guard.planGoalMutuallyExclusive"
      : "guard.readOnlyGoalMutuallyExclusive",
    restrictedMode === "plan"
      ? "Plan and Goal cannot be active at the same time."
      : "Ask mode and Goal cannot be active at the same time.",
  );
}

function goalCommandQueueText(displayText: string | undefined, objective: string): string {
  const trimmed = displayText?.trim();
  return trimmed ? trimmed : `/goal ${objective}`;
}

/**
 * pauseGoal：独立 target 控制，不复用通用 stop 的 queue hold/disposition。
 * 旧 V4 只有 stop，导致没有 active controller 时无法暂停目标，也让 UI 无法
 * 准确表达“暂停目标”与“终止本轮”的差别。先结算 target active run，再终止当前 goal work。
 */
async function pauseGoal(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return undefined;
  }

  const activeController = record.activeAbortController;
  const paused = await record.app.updateTargetStatus("paused");
  if (!paused) return undefined;

  activeController?.abort(new Error("v4 goal paused"));
  await host.afterLegacyStateMutation?.(record, "goal_paused");
  return undefined;
}

/**
 * resumeGoal：paused → active（stopPausesActiveGoalTarget 的逆操作）。
 * 无 target → 幂等成功（旧协议路径返回 "No goal to resume." 且不改状态，不抛错）。
 */
async function resumeGoal(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (record.activeAbortController) {
    // 同 sendGoalCommand：resume 属旧 goalSession 的非 pause 动作，运行中拒绝。
    throw new V4GoalCompactRejectedError(
      "activeTurn",
      "Cannot manage goals while a prompt is running",
    );
  }
  // 只跳过续跑仍会留下 active Goal + 叠加态；恢复目标前就检查，不能先写入再拒绝。
  const restrictedMode = restrictedGoalMode(record);
  if (restrictedMode && (await record.app.readTarget())) {
    throwGoalModeConflict(restrictedMode);
  }
  const target = await record.app.updateTargetStatus("active");
  if (!target) {
    host.logger?.info?.("v4 resumeGoal without target, noop", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
  await continueGoalAfterChange(host, record, {
    inputId: envelope.commandId,
    reason: "goal_resumed",
  });
  return undefined;
}

/**
 * goal 变更后的续跑（旧 continueGoalAfterChange 搬运，set/resume 两处共用）：
 * plan 模式或已有 active turn 时不续跑（只落库目标，用户后续显式推进）；
 * 否则模型就绪检查 → 上锁 → 后台 continueActiveTarget。
 */
async function continueGoalAfterChange(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
    reason: string;
  },
): Promise<void> {
  const isPlanMode = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget 是 App 的必选能力；能否继续只取决于当前模式和是否已有活跃 turn。
  const canContinue = !isPlanMode && !record.activeAbortController;
  if (canContinue) {
    await host.ensureModelReady?.(record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(host, record, {
        abortController,
        foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
        inputId: params.inputId,
        intent: params.intent,
      }),
    ).catch(() => {
      // 后台 goal continuation 的失败经事件流降级上报；兜底防 unhandled rejection。
    });
  }
  // 旧协议路径在续跑起跑后立即 afterStateMutation(goal_set/goal_replaced/goal_resumed)
  // → 钩子等价替代；v4 投影经 TargetChanged 事件自然收口。
  await host.afterLegacyStateMutation?.(record, params.reason);
}

async function runGoalContinuationInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
      intent: params.intent,
      queryId: params.inputId as SubmitPromptOptions["queryId"],
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    if (record.activeAbortController === params.abortController) {
      // 续跑结束后应立刻释放活跃锁；广播只是后续动作，
      // 如果继续占锁，连续 /goal 会被误判为已有活跃 turn。
      record.activeAbortController = undefined;
    }
  }
  await host.afterLegacyStateMutation?.(record, mutationReason);
}

export const goalCompactHandlers = { compact, pauseGoal, resumeGoal, sendGoalCommand };
