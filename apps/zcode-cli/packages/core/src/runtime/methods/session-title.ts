import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type {
  MessageId,
  MessagePart,
  MessageWithParts,
  ModelSelection,
  SessionInfo,
  SessionTitleSource,
  TraceContext,
} from "../deps.js";
import type { AgentTelemetryCausation, SessionTaskType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistFallbackGoalSummaryTitle,
  persistGeneratedGoalSummaryTitle,
} from "./goal-summary-title.js";
import {
  SESSION_TITLE_QUERY_SOURCE,
  SESSION_TITLE_REGENERATE_QUERY_SOURCE,
  generateTitleCandidate,
  normalizeTitleInput,
} from "./title-generation-sidecar.js";

const GENERATED_TITLE_EXPECTED_SOURCES: readonly SessionTitleSource[] = [
  "default",
  "first_input",
  "generated",
];
// 手动重生成允许覆盖用户手动命名过的标题：点击菜单就是显式意图，
// 不再受「custom 粘性」保护。粘性规则本身只针对首轮自动生成，不变。
const REGENERATED_TITLE_EXPECTED_SOURCES: readonly SessionTitleSource[] = [
  ...GENERATED_TITLE_EXPECTED_SOURCES,
  "custom",
];
const MIN_GENERATED_TITLE_INPUT_CHARS = 10;

// 与任务列表可见类型（bootstrap 的 TASK_LIST_SESSION_TYPES）保持同一集合：菜单挂在任务行上，
// 闸门放行列表可见的三种 taskType。core 不反向依赖 bootstrap，按仓库既有惯例接受带注释的复制
// （同 spec「不跨包抽取帧数组」的先例），两处语义必须一起改。
const TITLE_REGENERATION_TASK_TYPES: ReadonlySet<SessionTaskType> = new Set([
  "interactive",
  "fork",
  "workflow_parent",
]);

export function maybeStartSessionTitleGeneration(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId,
  traceContext: TraceContext,
  options?: {
    deferIfProviderRuntimeHeadersRefresh?: boolean;
    goalSummaryTargetID?: string;
  },
): boolean {
  return maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    deferIfProviderRuntimeHeadersRefresh: options?.deferIfProviderRuntimeHeadersRefresh,
    goalSummaryTargetID: options?.goalSummaryTargetID,
    messageID,
    traceContext,
  });
}

export function maybeStartDeferredSessionTitleGeneration(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId,
  traceContext: TraceContext,
): boolean {
  return maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    messageID,
    traceContext,
  });
}

export function maybeStartSessionTitleGenerationFromExternalInput(
  this: AgentRuntimeInternal,
  input: string,
  options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
): void {
  // /goal 这类协议命令不走普通 executeTurn，但 objective 仍是用户可见的首条意图。
  // 这里复用 title seed，不额外持久化 user message，避免为了标题生成污染聊天 transcript。
  maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    bypassShortInputGuard: true,
    goalSummaryTargetID: options?.goalSummaryTargetID,
    traceContext: options?.traceContext ?? this.rootTraceContext,
  });
}

function maybeStartSessionTitleGenerationFromSeed(
  this: AgentRuntimeInternal,
  input: string,
  options: {
    deferIfProviderRuntimeHeadersRefresh?: boolean;
    goalSummaryTargetID?: string;
    messageID?: MessageId;
    traceContext: TraceContext;
    bypassShortInputGuard?: boolean;
  },
): boolean {
  if (
    !shouldAttemptSessionTitleGeneration(this, input, {
      bypassShortInputGuard: options.bypassShortInputGuard,
    })
  ) {
    return false;
  }
  if (
    options.deferIfProviderRuntimeHeadersRefresh &&
    shouldDeferSessionTitleForRuntimeHeaders(this)
  ) {
    // 首条消息的 title generation 和主消息会共享同一个 runtimeModel。
    // 需要刷新 runtime headers 的 provider 先让主 turn 发出去，再异步补标题。
    return false;
  }
  this.sessionTitleGenerationAttempted = true;
  // 标题任务会越过当前 Turn 的生命周期。入队时冻结 causation，避免后续 await、
  // 调度器或实现重构使后台 Trace 静默丢失指向触发 Span 的 Link。
  const causation = this.agentTelemetry.captureCausation();

  const generation = generateAndPersistSessionTitle
    .call(this, input, options.messageID, options.traceContext, {
      causation,
      goalSummaryTargetID: options.goalSummaryTargetID,
    })
    .catch(async (error) => {
      this.logger?.warn("Session title generation failed", {
        ...traceContextToLogContext(options.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_title_generation.failed",
        module: "core.runtime",
        status: "failed",
      });
      if (options.goalSummaryTargetID) {
        await persistFallbackGoalSummaryTitle.call(this, {
          objective: input,
          reason: "session_title_generation_failed",
          targetID: options.goalSummaryTargetID,
          traceContext: options.traceContext,
        });
      }
    });
  void this.trackResidencyBlockingWork(generation).catch((error) => {
    this.logger?.warn("Session title fallback persistence failed", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_title_generation.fallback_failed",
      module: "core.runtime",
      status: "failed",
    });
  });
  return true;
}

function shouldAttemptSessionTitleGeneration(
  runtime: AgentRuntimeInternal,
  input: string,
  options: { bypassShortInputGuard?: boolean } = {},
): boolean {
  if (runtime.sessionTitleGenerationAttempted) return false;
  if (runtime.config.titleGeneration?.enabled === false) return false;
  if (!runtime.config.titleGeneration) return false;
  if (!runtime.sessionStore) return false;
  if (runtime.config.parentSessionId) return false;
  if (runtime.config.taskType && runtime.config.taskType !== "interactive") return false;
  if (runtime.turnNumber !== 0) return false;
  const normalizedInput = normalizeTitleInput(input);
  if (normalizedInput.length === 0) return false;
  // 短首发输入本身已经是可读标题，继续走 generated title sidecar
  // 会把 "hi" 这类标题稳定覆盖成泛化的 "New Coding Session"。
  return (
    options.bypassShortInputGuard ||
    Array.from(normalizedInput).length >= MIN_GENERATED_TITLE_INPUT_CHARS
  );
}

function shouldDeferSessionTitleForRuntimeHeaders(runtime: AgentRuntimeInternal): boolean {
  const runtimeHeadersPort = runtime.providerRuntimeHeadersPort;
  if (!runtimeHeadersPort) return false;
  const selection =
    runtime.config.titleGeneration?.modelSelection ?? runtime.getSessionModelSelection();
  if (!selection) return true;
  return (
    runtimeHeadersPort.shouldRefreshBeforeModelRequest?.({
      providerId: selection.providerId,
      modelId: selection.modelId,
    }) ?? true
  );
}

async function generateAndPersistSessionTitle(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
  options: {
    causation?: AgentTelemetryCausation;
    goalSummaryTargetID?: string;
  } = {},
): Promise<void> {
  const initialSession = await this.sessionStore?.getSession(this.sessionId);
  if (!initialSession || initialSession.parentID || initialSession.taskType !== "interactive") {
    return;
  }

  if (
    await shouldSkipGeneratedTitleForFirstQueryEdit.call(
      this,
      initialSession,
      messageID,
      traceContext,
    )
  ) {
    return;
  }

  const shouldPersistSessionTitle = initialSession.titleSource !== "custom";
  if (!shouldPersistSessionTitle && !options.goalSummaryTargetID) {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "custom_title",
    });
    return;
  }
  if (options.goalSummaryTargetID) {
    this.logger?.info("Goal summary title generation started", {
      ...traceContextToLogContext(traceContext),
      event: "goal_summary_title_generation.started",
      module: "core.runtime",
      querySource: SESSION_TITLE_QUERY_SOURCE,
      status: "started",
      targetId: options.goalSummaryTargetID,
    });
  }

  const generated = await generateTitleCandidate.call(this, input, {
    causation: options.causation,
    messageID,
    querySource: SESSION_TITLE_QUERY_SOURCE,
    traceContext,
  });
  if (!generated) {
    if (options.goalSummaryTargetID) {
      // 首次 /goal 会把 session title sidecar 同时当作 summaryTitle 来源；
      // 这个 sidecar 空响应时必须给目标摘要写兜底，否则第一轮迭代没有语义标题。
      await persistFallbackGoalSummaryTitle.call(this, {
        objective: input,
        reason: "session_title_empty",
        targetID: options.goalSummaryTargetID,
        traceContext,
      });
    }
    return;
  }

  if (shouldPersistSessionTitle) {
    await persistGeneratedSessionTitle.call(this, {
      messageID,
      mode: "first_turn",
      modelSelection: generated.modelSelection,
      title: generated.title,
      traceContext: generated.traceContext,
    });
  }

  if (options.goalSummaryTargetID) {
    await persistGeneratedGoalSummaryTitle.call(this, {
      targetID: options.goalSummaryTargetID,
      title: generated.title,
      traceContext: generated.traceContext,
    });
  }
}

/**
 * renameSession：用户显式重命名会话（titleSource=custom）。custom 之后自动标题
 * 生成会被跳过（见 persistGeneratedSessionTitle 的 custom_title 短路），持久化 + 发
 * SessionTitleUpdated(source:custom) 供 v4 投影 meta 更新。
 */
export async function setCustomSessionTitle(
  this: AgentRuntimeInternal,
  input: { title: string; traceContext: TraceContext },
): Promise<void> {
  const previous = await this.sessionStore?.getSession(this.sessionId);
  const previousTitle = previous?.title ?? "";
  await this.sessionStore?.updateSession({
    id: this.sessionId,
    title: input.title,
    titleSource: "custom",
  });
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        previousTitle,
        source: "custom",
        title: input.title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

/**
 * regenerateSessionTitle：用户显式点「重新生成标题」。
 *
 * 与首轮自动生成的三点差异，都是刻意的：
 * 1. 素材是会话实际内容（首条用户 query + 首条助手回复）而非首条 query 本身。
 *    首轮生成是纯函数 f(首条query)，同输入重跑必然同输出，功能等于空转。
 * 2. 不受 shouldAttemptSessionTitleGeneration 的四道闸约束（每会话一次 /
 *    turnNumber===0 / ≥10 字门槛），也不写 sessionTitleGenerationAttempted——
 *    那是首轮自动生成的私有标记，手动重生成不该污染它。
 * 3. 允许覆盖 titleSource=custom 并解除粘性：点菜单是显式用户意图。
 *
 * 失败必须抛出而不是静默 return：UI 靠 ACK failed 弹 toast 并撤掉占位符，
 * 静默失败会让前端一直卡在「生成中」。
 */
export async function regenerateSessionTitle(
  this: AgentRuntimeInternal,
  input: { traceContext: TraceContext },
): Promise<void> {
  if (!this.sessionStore) {
    throw new Error("Session title regeneration requires a session store");
  }
  const session = await this.sessionStore.getSession(this.sessionId);
  // 闸门按任务列表可见的 taskType 放行，不能用 parentID 判根：显式 fork 带 parent 却是
  // 列表可见主任务，按 parentID 拒绝会出现「菜单可见、后端必拒」的失败 toast。
  // subagent / 辅助对话 / workflow child 不在任务列表，拒绝属防御性校验。
  if (!session || !TITLE_REGENERATION_TASK_TYPES.has(session.taskType)) {
    throw new Error(
      "Session title regeneration requires a task-list session (interactive, fork, or workflow parent)",
    );
  }

  // 显式失败优于静默回退：会话原模型不可用时如实告诉用户原因，而不是悄悄换模型
  // （docs/specs/session-title-regeneration.md「会话模型不可用时的显式失败与原因提示」）。
  // 想钉住标题模型走 config.titleGeneration.modelSelection（优先级最高）。
  if (!this.config.titleGeneration?.modelSelection && !this.getSessionModelSelection()) {
    throw new SessionTitleRegenerationError(
      "title.modelUnavailable",
      "Session title regeneration has no usable model selection: the session's original model may have been disabled or removed, and no titleGeneration.modelSelection is configured",
    );
  }

  const material = await buildSessionTitleRegenerationMaterial.call(this, input.traceContext);
  if (!material) {
    throw new SessionTitleRegenerationError(
      "title.noMaterial",
      "Session title regeneration found no conversation content to summarize",
    );
  }

  // 入队时冻结 causation：await 之后 runtime 的隐式 trace context 可能已指向别处。
  const causation = this.agentTelemetry.captureCausation();
  const generated = await generateTitleCandidate.call(this, material.text, {
    causation,
    messageID: material.firstUserMessageID,
    querySource: SESSION_TITLE_REGENERATE_QUERY_SOURCE,
    traceContext: input.traceContext,
  });
  if (!generated) {
    throw new SessionTitleRegenerationError(
      "title.emptyResult",
      "Session title regeneration produced no title",
    );
  }

  await persistGeneratedSessionTitle.call(this, {
    messageID: material.firstUserMessageID,
    mode: "user_requested",
    modelSelection: generated.modelSelection,
    title: generated.title,
    traceContext: generated.traceContext,
  });
}

/**
 * 重生成失败的领域原因。v4 gateway 会把 `reasonCode` 原样放进 failed ACK，
 * UI 据此映射模态文案（未知 code 回退显示 ACK message 原文）。
 */
export type SessionTitleRegenerationFailureReason =
  | "title.modelUnavailable"
  | "title.noMaterial"
  | "title.emptyResult";

export class SessionTitleRegenerationError extends Error {
  constructor(
    readonly reasonCode: SessionTitleRegenerationFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "SessionTitleRegenerationError";
  }
}

/**
 * 重生成素材 = 会话**末尾段**的对话转录（2026-10-07 产品决策：与 History 一致，取末尾）。
 *
 * 早期版本取「首条用户 query + 首条助手回复」，但老会话的首条消息往往是
 * 「执行计划」「继续」或一个 plan 文件路径，信息量天然贫瘠——同素材喂同模型只会
 * 产出与旧标题雷同的低信息标题。会话「当前在做什么」由末尾段反映。
 *
 * 从最新消息往前收集可见真实用户消息与带文本的助手消息：预算内全收（更多上下文
 * 让标题更准），超预算时优先保留**末尾**（会话「当前在做什么」由末尾段反映，
 * 与 History 里最近可见内容一致），最早的内容先被丢弃。单条超预算时取该条开头截断。空会话 / 无可见用户消息返回 null，
 * 由调用方转成带原因的失败。
 */
async function buildSessionTitleRegenerationMaterial(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<{ firstUserMessageID: MessageId; text: string } | null> {
  const messages = await this.sessionStore?.messages({ sessionID: this.sessionId });
  if (!messages || messages.length === 0) return null;

  const MATERIAL_BUDGET_CHARS = 1200;
  const fragments: { userMessageID?: MessageId; speaker: "User" | "Assistant"; text: string }[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const isUser = isVisibleRealUserMessage(message);
    if (!isUser && message.info.role !== "assistant") continue;
    const text = extractMessageText(message);
    if (!text) continue;
    // 装不下的更早消息整条丢弃（break 而非截断拼入）：截半条旧内容只会让
    // 正序拼接超预算，被 normalizeTitleInput 二次截断后反而挤掉末尾内容。
    // fragments 为空时（最新一条本身就超预算）取该条开头，保证素材非空。
    if (text.length > MATERIAL_BUDGET_CHARS - used && fragments.length > 0) break;
    fragments.push({
      ...(isUser ? { userMessageID: message.info.id } : {}),
      speaker: isUser ? "User" : "Assistant",
      text: text.slice(0, MATERIAL_BUDGET_CHARS),
    });
    used += Math.min(text.length, MATERIAL_BUDGET_CHARS);
  }

  const firstUserMessageID = fragments.find((f) => f.userMessageID)?.userMessageID;
  if (!firstUserMessageID) return null;

  const text = [...fragments]
    .reverse()
    .map((f) => `${f.speaker}: ${f.text}`)
    .join("\n\n");

  this.logger?.debug("Session title regeneration material collected", {
    ...traceContextToLogContext(traceContext),
    event: "session_title_regeneration.material_collected",
    collectedTurns: fragments.length,
    module: "core.runtime",
  });
  return { firstUserMessageID, text: normalizeTitleInput(text) };
}

function extractMessageText(message: MessageWithParts): string {
  return message.parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

/**
 * 两条写回路径的差异不止 CAS 允许来源，还包括首条 query 编辑守卫：
 *
 * - `first_turn`（首轮自动生成）：必须跳过被编辑过的首条 query。那条守卫存在的
 *   原因是 sidecar 与主消息并发，用户可能在 LLM 返回前改写了首条 query，此时
 *   旧 query 的标题再写回就覆盖了用户的编辑意图。
 * - `user_requested`（手动「重新生成标题」）：绝不能套用那条守卫。素材是点击
 *   那一刻从消息库现取的，反映的就是当前会话状态；若用户当初编辑过首条 query，
 *   套用守卫会让这次点击**静默什么都不做**——正好是本路径要消灭的那种体验。
 *
 * 两种模式都覆盖 `custom`：前者受粘性保护短路，后者是显式用户意图。
 */
type SessionTitleWriteMode = "first_turn" | "user_requested";

async function persistGeneratedSessionTitle(
  this: AgentRuntimeInternal,
  input: {
    messageID: MessageId | undefined;
    mode: SessionTitleWriteMode;
    modelSelection: ModelSelection;
    title: string;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 标题 sidecar 现在会在首条 query 落库后并发启动，用户可能在 LLM 返回前编辑首条 query。
  // 写回前重新读取 session，避免旧 query 的 generated title 覆盖编辑后的首屏标题语义。
  const isUserRequested = input.mode === "user_requested";
  const session = isUserRequested
    ? ((await this.sessionStore?.getSession(this.sessionId)) ?? null)
    : await getSessionForGeneratedTitle.call(this, input.messageID, input.traceContext);
  // 首轮自动生成维持仅 interactive（spec：首轮行为逐字不变）；手动重生成与入口闸门共用
  // TITLE_REGENERATION_TASK_TYPES——fork / workflow_parent 是任务列表可见任务，用户点了
  // 菜单就必须写回。这里若再按 parentID 拒绝，会变成「模型已生成但静默不落库」，正是
  // spec 失败一节禁止的静默失败（UI 占位符虽由 ACK 清除，标题却停在旧值）。
  if (!session) return;
  if (isUserRequested) {
    if (!TITLE_REGENERATION_TASK_TYPES.has(session.taskType)) return;
  } else if (session.parentID || session.taskType !== "interactive") {
    return;
  }
  if (session.titleSource === "custom" && !isUserRequested) {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "custom_title",
    });
    return;
  }

  const previousTitle = session.title;
  const expectedTitleSources = isUserRequested
    ? REGENERATED_TITLE_EXPECTED_SOURCES
    : GENERATED_TITLE_EXPECTED_SOURCES;
  const updated = await this.sessionStore?.updateSession({
    expectedTitleSources,
    id: this.sessionId,
    title: input.title,
    ...(input.messageID ? { titleMessageID: input.messageID } : {}),
    titleSource: "generated",
  });
  if (!updated || updated.title !== input.title || updated.titleSource !== "generated") {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "title_source_changed",
    });
    return;
  }

  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        // 旧持久化事件 DTO 尚未迁移；不把该投影重新暴露为标题生成配置。
        ...(input.messageID ? { messageID: input.messageID } : {}),
        previousTitle,
        source: "generated",
        title: input.title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

async function getSessionForGeneratedTitle(
  this: AgentRuntimeInternal,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
): Promise<SessionInfo | null> {
  const session = await this.sessionStore?.getSession(this.sessionId);
  if (!session || session.parentID || session.taskType !== "interactive") return null;
  if (
    await shouldSkipGeneratedTitleForFirstQueryEdit.call(this, session, messageID, traceContext)
  ) {
    return null;
  }
  return session;
}

async function shouldSkipGeneratedTitleForFirstQueryEdit(
  this: AgentRuntimeInternal,
  session: SessionInfo,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
): Promise<boolean> {
  if (!(await isSuppressedByFirstQueryEdit.call(this, session, messageID))) return false;
  this.logger?.debug("Session title generation skipped", {
    ...traceContextToLogContext(traceContext),
    event: "session_title_generation.skipped",
    module: "core.runtime",
    reason: "first_query_edited",
  });
  return true;
}

async function isSuppressedByFirstQueryEdit(
  this: AgentRuntimeInternal,
  session: SessionInfo,
  messageID: MessageId | undefined,
): Promise<boolean> {
  // 编辑首条 query 会通过 conversation_rewind 把 target 指向旧用户消息。
  // 旧 query 的标题请求即使已经发出，也只能记录用量，不能再写回会话标题。
  if (messageID && session.revert?.targetMessageID === messageID) return true;
  return hasEditedFirstVisibleUserQuery.call(this, session);
}

async function hasEditedFirstVisibleUserQuery(
  this: AgentRuntimeInternal,
  session: SessionInfo,
): Promise<boolean> {
  const revert = session.revert;
  if (revert?.kind !== "conversation_rewind" || !revert.targetMessageID) return false;
  const keptMessageIds = new Set(revert.keptMessageIDs ?? []);
  if (keptMessageIds.size === 0) return true;

  const messages = await this.sessionStore?.messages({ sessionID: this.sessionId });
  if (!messages) return false;
  return !messages.some(
    (message) => keptMessageIds.has(message.info.id) && isVisibleRealUserMessage(message),
  );
}

function isVisibleRealUserMessage(message: MessageWithParts): boolean {
  const info = message.info;
  return info.role === "user" && info.synthetic !== true && info.visibility !== "model-only";
}
