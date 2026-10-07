// fork/edit/retry 命令组：forkAssistant / editUserQuery / retryTurn。
// 共同点：都以 {rowId, entityId} 定位历史实体，经 host 的 v4 投影翻译面换成 transcript messageId
// （翻译是 v4 原生决策，翻译不到直接 reject，绝不静默兜底 latestCheckpoint——会错点）。
// - editUserQuery = 换文本的 retryTurn：rewind 截断该 turn → 原生 prompt turn 重发新文本。
// - retryTurn = rewind 截断 + 重发原 user prompt（原文必须在 rewind 前解析，截断后拿不到）。
// - forkAssistant = stable resolver + conversation-only copy；running parent 与 workspace 不动。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { hasGoalCommandToken } from "@zcode/shared";
import {
  RewindStrategy,
  traceContextToLogContext,
  type MessageId,
  type TurnId,
} from "@zcode/contracts";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromCanonical } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { commandAdmissionOf } from "../executor.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  hasPromptInput,
  preemptActiveTurnAndWait,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "./session-flow.js";
import { applyGoalCommand, parseGoalObjectiveFromCommandText } from "./goal-compact.js";
import type { ConversationEditTarget } from "../../product-projection.js";

const CONVERSATION_COMMAND_LOG_MODULE = "bootstrap.zcode_protocol_v4.commands";
const EDIT_USER_QUERY_COMPLETED_EVENT = "conversation.command.edit_user_query.completed";
const FORK_ASSISTANT_COMPLETED_EVENT = "conversation.command.fork_assistant.completed";

/** row target → messageId 翻译失败（非 assistant 行 / 迟到实体 / 会话无投影）。 */
export class V4RowTranslationError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(command: string, targetRowId: number) {
    super(`${command} targetRowId ${targetRowId} 无法解析到 transcript messageId`);
    this.name = "V4RowTranslationError";
  }
}

/** fork 目标不是所属轮最后一段 assistantText → 明确拒绝。 */
export class V4ForkTargetNotLatestSegmentError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(targetRowId: number) {
    super(
      `forkAssistant targetRowId ${targetRowId} 不是所属轮的最后一段 assistant（fork 只挂轮尾段）`,
    );
    this.name = "V4ForkTargetNotLatestSegmentError";
  }
}

class V4ForkTargetGuardError extends Error {
  constructor(
    readonly reasonCode: string,
    targetRowId: number,
  ) {
    super(`forkAssistant targetRowId ${targetRowId} 被稳定目标解析器拒绝: ${reasonCode}`);
    this.name = "V4ForkTargetGuardError";
  }
}

/**
 * 中间轮编辑放开（specs/message-history-edit.md）后，正常路径不再要求目标是最
 * 后一轮；此错误保留为并发竞态防护——提交时目标已不在投影可编辑集合
 * （如另一端已发送新消息或完成编辑）。
 */
class V4EditTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestQueryEditOnly";

  constructor(targetRowId: number) {
    super(`editUserQuery targetRowId ${targetRowId} 不是最后一轮 real user query`);
    this.name = "V4EditTargetNotLatestError";
  }
}

/** latestAssistantRetryOnly：历史 assistant 回复 retry 会回退 active branch，必须拒绝。 */
class V4RetryTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestAssistantRetryOnly";

  constructor(targetRowId: number) {
    super(`retryTurn targetRowId ${targetRowId} 不是最后一轮 assistant 回复`);
    this.name = "V4RetryTargetNotLatestError";
  }
}

/**
 * rewind 截断（直驱 core）：edit/retry 不再伪造 `/rewind` slash turn，而是
 * 直接提交 same-session active branch cut。workspaceMode=rewind 会在文件写入全部
 * 成功后，于同一 commit gate 调用这个 primitive。
 *
 * 组合 rewind 过去在 file transaction callback 中调用 app.submitPrompt，
 * 它会把 `/rewind` 再排入 runtime command queue；当前 edit 命令等待回调，
 * 嵌套 rewind 又等待当前命令释放队列，最终 UI 永久停在编辑态。
 * 完成后 legacy 广播 session_rewound（过渡钩子，旧侧栏消费者感知；v4 投影走
 * RewindTriggered 事件自收口，不依赖本广播）。
 */
async function submitConversationRewind(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  anchorMessageId: string,
): Promise<void> {
  const result = await record.app.runtime.rewindConversationToMessage({
    events: [],
    targetMessageId: anchorMessageId as MessageId,
    traceContext: record.traceContext,
  });
  if (result.strategy !== RewindStrategy.ActiveChain) {
    throw new Error(`conversation rewind unavailable for ${anchorMessageId}: ${result.strategy}`);
  }
  await host.afterLegacyStateMutation?.(record, "session_rewound");
}

/**
 * editUserQuery：target 是 user 实体，用其 canonical transcript messageId 作 rewind
 * 锚点 → 整段截断 → 原生 prompt turn 重发 newText。
 * 放开中间轮编辑（specs/message-history-edit.md）后 target 可以是任意可编辑
 * realUser 轮：截断锚点即该轮，其后的轮次全部剪除（截断语义）。
 * 附件命令面：attachments（AttachmentRef → TurnAttachment）随重发提交。
 */
/**
 * 规则 26/29：覆盖选项只对「全部冲突都是外部修改」的 preview 出现——恢复数据
 * （checkpoint）还在，只是磁盘内容与预期不一致；缺失/不可读/不支持的 checkpoint
 * 没有可恢复的数据，覆盖无意义，永远保持 fail-closed。
 */
function areAllUnsafeOverridable(preview: { unsafeFiles: Array<{ reason: string }> }): boolean {
  return (
    preview.unsafeFiles.length > 0 &&
    preview.unsafeFiles.every((file) => file.reason === "external_modified")
  );
}

/**
 * editUserQuery rewind 分支的文件回滚裁决（specs/message-history-edit.md 规则
 * 24-26）。纯函数便于单测；editUserQuery 只执行结论不再内联判断。
 * - none：范围内没有任何涉及文件（safe/unsafe/ignored 均空）＝无文件可恢复，
 *   不是失败，等价纯对话编辑，不再走 blocked。
 * - apply：全部安全可恢复（block）；或用户显式选择覆盖且冲突全部为
 *   external_modified（overwrite）。ignored=bash 变更没有 checkpoint，覆盖救不回。
 * - blocked：存在无法越过的冲突，把最新 preview 原样返回 UI。
 */
export function resolveEditFileRewindExecution(
  preview: {
    canApply: boolean;
    safeFiles: unknown[];
    unsafeFiles: Array<{ reason: string }>;
    ignoredFiles: unknown[];
  },
  conflictMode: "block" | "overwrite" | undefined,
):
  | { action: "none" }
  | { action: "apply"; conflictMode: "block" | "overwrite" }
  | {
      action: "blocked";
      reasonCode: "guard.workspaceRewindIgnoredFiles" | "guard.workspaceRewindUnsafeFiles";
    } {
  const hasInvolvedFiles =
    preview.safeFiles.length > 0 ||
    preview.unsafeFiles.length > 0 ||
    preview.ignoredFiles.length > 0;
  if (!hasInvolvedFiles) return { action: "none" };
  const canOverwrite =
    conflictMode === "overwrite" &&
    preview.ignoredFiles.length === 0 &&
    areAllUnsafeOverridable(preview);
  if ((preview.canApply && preview.ignoredFiles.length === 0) || canOverwrite) {
    return { action: "apply", conflictMode: canOverwrite ? "overwrite" : "block" };
  }
  return {
    action: "blocked",
    reasonCode:
      preview.ignoredFiles.length > 0
        ? "guard.workspaceRewindIgnoredFiles"
        : "guard.workspaceRewindUnsafeFiles",
  };
}

/**
 * 编辑路径的 Goal 门禁（specs/message-history-edit.md 规则 32 重判）。新文本含
 * goal token 时按发送同款规则裁决：附件/上下文 → 档位 → 空目标。任何拒绝都必须
 * 发生在 rewind 之前——截断一旦提交、重发又失败，用户面对的就是「历史被剪掉
 * 但什么都没发生」。判定与发送同源：token 用 @zcode/shared 唯一真源，目标正文
 * 复用队列路径同一份解析器（queue.ts 提升消费同款）。
 */
function editGoalGateReason(
  newText: string,
  attachmentCount: number,
  submittedMode: "yolo" | "plan" | "readonly",
): string | null {
  if (attachmentCount > 0) return "guard.goalAttachmentsBlocked";
  if (submittedMode !== "yolo") {
    return submittedMode === "plan"
      ? "guard.planGoalMutuallyExclusive"
      : "guard.readOnlyGoalMutuallyExclusive";
  }
  if (!parseGoalObjectiveFromCommandText(newText)) return "emptyObjective";
  return null;
}

async function editUserQuery(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editUserQuery"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "editUserQuery",
  );
  if (!resolution?.ok || !resolution.editTarget) {
    throw new V4EditTargetNotLatestError(payload.target.rowId);
  }
  const editTarget = resolution.editTarget;
  const attachmentRefs = payload.attachments ?? stableAttachmentRefs(editTarget);
  // attachments 缺省与 [] 语义不同；必须基于 effective refs 校验，
  // 才能同时允许 attachment-only edit，并在正文和附件都被清空时于 rewind 前拒绝。
  if (!hasPromptInput(payload.newText, attachmentRefs)) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  // 命令身份按编辑后的新文本重判（规则 32 改写）：token 是唯一真源，不再固定
  // 继承旧行 kind——普通消息编辑成 /goal 就要真的生效，goal 行删掉 token 就
  // 回归普通重发。判定结果同时驱动门禁与 canonical intent 重建。
  const editCommandKind = hasGoalCommandToken(payload.newText) ? "sendGoalCommand" : "sendText";
  let intentOverrides: EditExecutionOverrides = {
    mode: payload.mode,
    modelSelection: payload.modelSelection,
    planEnabled: payload.planEnabled,
    readOnlyEnabled: payload.readOnlyEnabled,
  };
  if (editCommandKind === "sendGoalCommand") {
    // 档位与发送同源（resolveSubmittedExecutionState）：payload.mode 优先，缺省
    // 回落会话当前档，协议直连不带 mode 时按会话档 fail-closed。解析出的档位
    // 同时写回 intent 覆盖——旧行 admission 可能停在早已切换的档位上，照抄冻结值
    // 会让 applyGoalCommand 在 rewind 之后才拒绝，违反拒绝前置。
    const submittedMode = resolveSubmittedExecutionState(record, payload).mode;
    const gateReason = editGoalGateReason(
      payload.newText,
      attachmentRefs?.length ?? 0,
      submittedMode,
    );
    if (gateReason) {
      await host.cancelInputCommand?.(
        record.app.sessionId,
        commandAdmissionOf(envelope).queueItemId,
        gateReason,
      );
      return {
        type: "editUserQuery",
        disposition: "blocked",
        sessionId: record.app.sessionId,
        reasonCode: gateReason,
      };
    }
    intentOverrides = {
      ...intentOverrides,
      mode: submittedMode,
      planEnabled: submittedMode === "plan",
      readOnlyEnabled: submittedMode === "readonly",
    };
  }
  // 附件映射在 rewind 前完成：引用失效要在截断历史之前暴露，避免半程失败。
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  // 运行中编辑重发（specs/message-history-edit.md 规则 18，2026-10-07 修订）：
  // 内部抢占 ≠ 用户 Stop——必须保留队列 autoDrain（preserve），否则被中止 turn 的
  // cancelled 收口会关掉 autoDrain，重发输入一旦因 busy 尾巴入队就与「队列已暂停」
  // 横幅叠加成需要手动恢复的死队列；重发输入以 promotion lease 占住空闲位 +
  // requireIdle 直接启动，不落入队列。busy 判定补上 Core 自持前台执行
  // （background notification 的 model-only turn 无 Bootstrap controller）。
  const editResendBusy =
    record.activeAbortController !== undefined ||
    record.app.runtime?.getActiveForegroundExecutionId?.() !== undefined;
  const editResendLeaseId = `edit-resend:${envelope.commandId}`;
  let editResendLeaseAcquired = false;
  const releaseEditResendLease = (): void => {
    if (!editResendLeaseAcquired) return;
    record.app.runtime.releaseForegroundPromotionLease(editResendLeaseId);
    editResendLeaseAcquired = false;
  };
  if (editResendBusy) {
    const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
      leaseId: editResendLeaseId,
      mode: "after-current",
      promotedInputId: envelope.commandId,
    });
    if (leaseResult.kind !== "acquired") {
      // 另一条立即发送/队列提升正在抢占；rewind 尚未发生，拒绝不留半程状态。
      throw new V4InputAdmissionRejectedError(
        "fault.command.inputRejected",
        "edit resend foreground promotion is busy",
      );
    }
    editResendLeaseAcquired = true;
    try {
      await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 editUserQuery preempts active turn",
        goalPausedMutationReason: "edit_user_query_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
        // 自己持有的 lease 不算 busy，否则 idle 轮询看到自己直到超时。
        waitExcludeForegroundPromotionLeaseId: editResendLeaseId,
      });
    } catch (error) {
      releaseEditResendLease();
      throw error;
    }
  }
  try {
    let conversationRewindCommitted = false;
    if ((payload.workspaceMode ?? "preserve") === "rewind") {
      // 文件回滚范围 = 目标行及其后全部消息（specs/message-history-edit.md 规则 10）：
      // 中间轮编辑要级联恢复被剪除的后续轮 checkpoint；末轮时集合与单轮收集等价
      //（多出的消息没有 checkpoint，不贡献恢复项）。
      const turnMessageIds = resolution.messageIds ??
        host.getMessageIdsAfterRow?.(record.app.sessionId, resolution.row.rowId) ??
        host.getMessageIdsForTurnRow?.(record.app.sessionId, resolution.row.rowId) ?? [
          editTarget.transcriptMessageId,
        ];
      const fileOptions = {
        targetMessageIds: turnMessageIds as MessageId[],
        targetTurnId: resolution.row.turnId as TurnId,
        traceContext: record.traceContext,
      };
      const preview = await record.app.runtime.previewWorkspaceFileRewind(fileOptions);
      const execution = resolveEditFileRewindExecution(preview, payload.fileRewindConflict);
      if (execution.action === "blocked") {
        // shell/ignored 变更无法证明完整回滚。组合模式 fail closed，并把最新 preview 原样返回 UI。
        await host.cancelInputCommand?.(
          record.app.sessionId,
          commandAdmissionOf(envelope).queueItemId,
          execution.reasonCode,
        );
        return {
          type: "editUserQuery",
          disposition: "blocked",
          sessionId: record.app.sessionId,
          reasonCode: execution.reasonCode,
          preview,
        };
      }
      if (execution.action === "apply") {
        const applied = await record.app.runtime.applyWorkspaceFileRewind({
          ...fileOptions,
          conflictMode: execution.conflictMode,
          anchorMessageId: editTarget.transcriptMessageId as MessageId,
          commitAfterApply: async () => {
            await submitConversationRewind(host, record, editTarget.transcriptMessageId);
            conversationRewindCommitted = true;
          },
        });
        if (!applied.applied) {
          await host.cancelInputCommand?.(
            record.app.sessionId,
            commandAdmissionOf(envelope).queueItemId,
            "guard.workspaceRewindApplyConflict",
          );
          return {
            type: "editUserQuery",
            disposition: "blocked",
            sessionId: record.app.sessionId,
            reasonCode: "guard.workspaceRewindApplyConflict",
            preview: applied.preview,
          };
        }
      }
    }
    if (!conversationRewindCommitted) {
      await submitConversationRewind(host, record, editTarget.transcriptMessageId);
    }
    await startCanonicalIntent(
      host,
      record,
      envelope,
      editTarget,
      payload.newText,
      attachmentRefs,
      attachments,
      intentOverrides,
      editCommandKind,
      // 重判为 goal 时落库可见文本用编辑原文（含 token），保真前文与原大小写。
      editCommandKind === "sendGoalCommand" ? payload.newText : undefined,
      // 抢占路径的重发必须占用空闲位直接启动：缺 requireIdle 会在旧 turn 收尾尾巴
      // （drain/队列残留）仍算 busy 时被 admission 推进队列。静态编辑不传，保持原语义。
      editResendBusy ? { requireIdle: true } : undefined,
    );
  } finally {
    releaseEditResendLease();
  }
  // 生产 renderer 不落日志，过去只能从通用 rewind + send 猜测发生过编辑，
  // 无法与 retry 稳定区分。命令副作用完成后由 Agent server 写低频 info 审计索引。
  host.logger?.info?.("v4 editUserQuery completed", {
    ...traceContextToLogContext(record.traceContext),
    attachmentCount: attachmentRefs?.length ?? 0,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: EDIT_USER_QUERY_COMPLETED_EVENT,
    // 审计记重判后的命令身份：旧行 kind 已不代表本次重发的语义。
    intentKind: editCommandKind,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    sessionId: record.app.sessionId,
    status: "completed",
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
    workspaceMode: payload.workspaceMode ?? "preserve",
  });
  return {
    type: "editUserQuery",
    disposition: "rewind",
    sessionId: record.app.sessionId,
  };
}

/**
 * retryTurn：assistant target → messageId → rewind 截断 + 重发
 * canonical user intent。intent 在 projection resolver 阶段、rewind **之前**完成解析，
 * 截断后不再回读可见文本或 transcript parent 猜测原输入。
 */
async function retryTurn(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["retryTurn"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "retryTurn",
  );
  if (!resolution?.ok || !resolution.messageId || !resolution.editTarget) {
    throw new V4RetryTargetNotLatestError(payload.target.rowId);
  }
  const attachmentRefs = stableAttachmentRefs(resolution.editTarget);
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  await submitConversationRewind(host, record, resolution.messageId);
  await startCanonicalIntent(
    host,
    record,
    envelope,
    resolution.editTarget,
    resolution.editTarget.intent.text,
    attachmentRefs,
    attachments,
    // 重试不改文本：命令身份沿用旧行，goal 行的重发不走新文本重判。
    undefined,
    resolution.editTarget.intent.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
  );
  return undefined;
}

/**
 * forkAssistant：唯一 stable resolver 固定 logical-turn/message boundary，再走
 * conversation-only fork。此路径不读取 activeAbortController、不 stop parent，也不进入
 * legacy forkSession（后者含 ensureNoActiveTurn + workspace rewind）。
 */
async function forkAssistant(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["forkAssistant"];
  const record = requireRecord(host, envelope.sessionId);
  const targetResolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "forkAssistant",
  );
  if (!targetResolution?.ok) {
    throw new V4ForkTargetGuardError("guard.forkTargetNotStable", payload.target.rowId);
  }
  if (!host.resolveStableForkTarget) {
    throw new Error("v4 forkAssistant requires host.resolveStableForkTarget capability");
  }
  const resolution = await host.resolveStableForkTarget(record.app.sessionId, payload.target.rowId);
  if (!resolution.ok) {
    throw new V4ForkTargetGuardError(resolution.reasonCode, payload.target.rowId);
  }
  if (!host.forkStableConversation) {
    throw new Error("v4 forkAssistant requires host.forkStableConversation capability");
  }
  const { forkedSessionId } = await host.forkStableConversation(record.app.sessionId, {
    target: resolution.target,
    goalBoundary: resolution.goalBoundary,
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    // fork 那一刻的界面语言快照；缺省（旧客户端）由 Host 回退继承父会话。
    ...(payload.language ? { language: payload.language } : {}),
  });
  // fork 完成事实过去只在 session event/debug 中，生产默认 JSONL 无法直接检索。
  // child 已创建并完成宿主注册后再写 info，避免把被拒绝或失败的请求误记为成功。
  host.logger?.info?.("v4 forkAssistant completed", {
    ...traceContextToLogContext(record.traceContext),
    childSessionId: forkedSessionId,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: FORK_ASSISTANT_COMPLETED_EVENT,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    parentSessionId: record.app.sessionId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    sessionId: record.app.sessionId,
    status: "completed",
    targetBoundaryMessageId: resolution.target.boundaryMessageId,
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
  });
  const result = { type: "forkAssistant" as const, sessionId: forkedSessionId };
  return result;
}

function stableAttachmentRefs(editTarget: ConversationEditTarget) {
  return editTarget.intent.attachments?.flatMap((attachment) =>
    attachment.ref ? [{ ...attachment, ref: attachment.ref }] : [],
  );
}

/**
 * 编辑重发的执行参数覆盖（specs/message-history-edit.md 规则 5-7）：
 * 显式传入的字段用新值，缺省 undefined 的字段继承目标轮当年 admission 冻结值。
 */
type EditExecutionOverrides = Pick<
  CommandPayloadMap["editUserQuery"],
  "mode" | "modelSelection" | "planEnabled" | "readOnlyEnabled"
>;

async function startCanonicalIntent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  attachments: Awaited<ReturnType<typeof mapAttachmentRefsToTurnAttachments>>,
  overrides?: EditExecutionOverrides,
  /**
   * 重发命令的身份（specs/message-history-edit.md 规则 32 重判）：editUserQuery 按
   * 新文本 token 重判后传入，retryTurn 沿用旧行 kind。不再信任 editTarget.intent.kind。
   */
  commandKind: "sendText" | "sendGoalCommand" = "sendText",
  /** goal 重发的落库可见文本（编辑原文含 token）；缺省由落库单点构造 `/goal <objective>`。 */
  goalDisplayText?: string,
  /** 抢占路径的重发占用空闲位：透传给 startPromptTurn → Core admission requireIdle。 */
  options?: { requireIdle?: boolean },
): Promise<void> {
  // goal 的 canonical text 必须是 token 之后的正文：旧行 intent.text 历史上就是
  // 纯目标正文（无 token，slice 原样返回 trim 全文），编辑进来的新文本则是整段
  // 含 token 的原文——统一在这里解析，token 与前文不得混进 target。
  const isGoal = commandKind === "sendGoalCommand";
  const objective = isGoal ? parseGoalObjectiveFromCommandText(text) : text;
  const goalText = objective.trim();
  const intent = inputIntentMetadataFromCanonical(
    envelope,
    {
      kind: commandKind,
      text: isGoal ? goalText : editTarget.intent.text,
      sourceCommandId: editTarget.intent.sourceCommandId,
      clientId: editTarget.intent.clientId,
      queueItemId: editTarget.intent.queueItemId,
      requestedDelivery: editTarget.intent.requestedDelivery,
      admittedDelivery: editTarget.intent.admittedDelivery,
      fallbackReasonCode: editTarget.intent.fallbackReasonCode,
      modelSelection: overrides?.modelSelection ?? editTarget.intent.modelSelection,
      mode: overrides?.mode ?? editTarget.intent.mode,
      planEnabled: overrides?.planEnabled ?? editTarget.intent.planEnabled,
      readOnlyEnabled: overrides?.readOnlyEnabled ?? editTarget.intent.readOnlyEnabled,
      attachmentRefs,
      provenance: editTarget.intent.provenance,
    },
    isGoal ? goalText : text,
  );
  if (isGoal) {
    // 编辑与 retry 都是「现在执行、载荷带用户本次显式选择的档位」，等同
    // sendGoalCommand 的立即分支。缺 delivery 会让 applyImmediateGoalMode 跳过落档，
    // 受限判定读会话旧档（如旧行 admission 冻结的 readonly）在 rewind 之后才拒绝，
    // 造成「历史已截断、目标未落」的半程状态——违反拒绝前置（规则 32）。
    await applyGoalCommand(host, record, {
      delivery: "immediate",
      inputId: envelope.commandId,
      objective: goalText,
      intent,
      // goal 行落库形态（goal-command-scope-and-decoration.md「落库形态」）：编辑场景
      // 必须传编辑原文——它含 token 之前的前文与原大小写，依赖缺省构造会静默抹掉。
      // retry 场景不传（旧行 intent.text 是纯 objective），由落库单点构造
      // `/goal <objective>`。修复前两条路径都不带 token 落库，commandKind 判成 goal
      // 气泡却画不出芯片（「目标设置成功但标志消失」）。
      ...(goalDisplayText ? { displayText: goalDisplayText } : {}),
    });
    return;
  }
  await startPromptTurn(host, record, {
    content: text,
    inputId: envelope.commandId,
    intent,
    ...(attachments ? { attachments } : {}),
    ...(options?.requireIdle ? { requireIdle: true } : {}),
  });
}

export const forkEditRetryHandlers = {
  forkAssistant,
  editUserQuery,
  retryTurn,
};
