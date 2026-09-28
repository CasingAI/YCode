// 补投升格原语：把「时间线上应看得见」的孤儿用户输入收进转录。
//
// 唯一写入所有者：本原语内部走 persistUserPrompt + promoteSessionInput 原子事务；
// 冷恢复补投、历史幽灵行捞取、回合逃逸兜底共用它，不另开第二条写转录路径。
// 补投不自动开回合：消息按账本创建时间落回历史位置，助手不接着跑那一轮。
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type {
  MessageId,
  TraceContext,
  TurnInputIntentMetadata,
  TurnState,
} from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildRuntimeUserEntriesFromTurn,
  resolveTurnAttachments,
  runtimeMetadataForSyntheticUserMessageSource,
} from "../helpers/index.js";

export interface PromoteOrphanedUserInputOptions {
  /** 账本行 id（queueItemId）。 */
  sessionInputId: string;
  /**
   * 优先取调用方已持有的正文（如回合逃逸前本回合的 input）；缺省读账本 payload.text。
   */
  text?: string;
  /** 消息创建时间；缺省取账本 time.created，气泡与模型历史落回原发送位置。 */
  createdAt?: number;
  /** 优先取调用方已持有的 intent；缺省从账本 payload 恢复。 */
  intent?: TurnInputIntentMetadata;
  /**
   * 未解析附件（账本 attachmentRefs 已由 bootstrap 映射为 TurnAttachment）。
   * 现场解析后丢弃失败占位（metadata.errorCode）：附件找不到就只留正文。
   */
  attachments?: TurnState["attachments"];
  /** 逃逸路径优先复用本回合已解析的附件，原样持久化。 */
  resolvedAttachments?: ResolvedTurnAttachment[];
  /** live 会话把消息补进内存历史（只写库下一轮模型仍看不到）；冷恢复水合前传 false。 */
  hydrateIntoHistory?: boolean;
  /** 逃逸路径复用本回合已分配的 user messageId；缺省新生成。 */
  messageId?: MessageId;
  traceContext: TraceContext;
}

export type PromoteOrphanedUserInputResult =
  | { status: "promoted"; messageId: MessageId; skippedSharedContextIds?: string[] }
  /** 账本已是 promoted：成功路径重复触发时不得再写一条用户消息。 */
  | { status: "already-promoted" }
  /** 转录已有相同命令号的用户消息：跳过写消息，只把账本补成 promoted。 */
  | { status: "duplicate"; messageId: MessageId }
  /** 账本行或 store 不存在，无法补投。 */
  | { status: "missing" };

function restoreIntentFromPayload(
  payload: { text: string; [key: string]: unknown },
): TurnInputIntentMetadata | undefined {
  const candidate = payload.intent;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  if (typeof record.sourceCommandId !== "string" || record.sourceCommandId.length === 0) {
    return undefined;
  }
  // v4 准入写入的 payload.intent 与 TurnInputIntentMetadata 同构；这里只校验
  // 补投依赖的关键身份字段，不做完整 schema 往返。
  return candidate as TurnInputIntentMetadata;
}

function sourceCommandIdOfPayload(
  payload: { text: string; [key: string]: unknown },
): string | undefined {
  for (const candidate of [payload.conversationInputIntent, payload.intent]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const sourceCommandId = (candidate as Record<string, unknown>).sourceCommandId;
    if (typeof sourceCommandId === "string" && sourceCommandId.length > 0) return sourceCommandId;
  }
  return undefined;
}

export function buildSharedContextNoticeText(contextIds: readonly string[]): string {
  return [
    "[shared context unavailable]",
    `The user tried to attach shared context (${contextIds.join(", ")}) to the previous message, but the import could not be attached when the message entered the transcript, so the shared context content is missing.`,
    "Do not fabricate its content. Ask the user to re-share the context if it is still needed.",
  ].join("\n");
}

export async function promoteOrphanedUserInput(
  this: AgentRuntimeInternal,
  options: PromoteOrphanedUserInputOptions,
): Promise<PromoteOrphanedUserInputResult> {
  const store = this.sessionStore;
  if (!store?.getSessionInputById) return { status: "missing" };
  const record = await store.getSessionInputById(options.sessionInputId);
  if (!record || record.sessionID !== this.sessionId) return { status: "missing" };
  if (record.status === "promoted") return { status: "already-promoted" };

  const text = options.text ?? record.payload.text ?? "";
  const intent = options.intent ?? restoreIntentFromPayload(record.payload);
  const sourceCommandId =
    intent?.sourceCommandId ?? sourceCommandIdOfPayload(record.payload);
  if (!text || !sourceCommandId) {
    // 无正文或解析不出命令号的行不是可补投的用户输入；交给调用方按清扫规则处理。
    return { status: "missing" };
  }

  // 去重：转录里已有相同命令号的用户消息则跳过写消息（避免双气泡），
  // 账本若仍非 promoted 只补账本状态（markSessionInputPromoted 只动非 promoted 行）。
  const existing = (await store.messages({ sessionID: this.sessionId })).find(
    (message) =>
      message.info.role === "user" && message.info.anchor?.sourceCommandId === sourceCommandId,
  );
  if (existing) {
    if (store.markSessionInputPromoted) {
      await store.markSessionInputPromoted({
        id: record.id,
        sessionID: this.sessionId,
        promotedMessageID: existing.info.id as MessageId,
      });
    }
    return { status: "duplicate", messageId: existing.info.id as MessageId };
  }

  let resolvedAttachments: ResolvedTurnAttachment[] | undefined;
  if (options.resolvedAttachments) {
    resolvedAttachments = options.resolvedAttachments;
  } else if (options.attachments && options.attachments.length > 0) {
    const resolved = await resolveTurnAttachments(options.attachments, {
      artifactStore: this.artifactStore,
      fileSystemPort: this.fileSystemPort,
      imageProcessorPort: this.imageProcessorPort,
      sessionId: this.sessionId,
      traceContext: options.traceContext,
      workingDirectory: this.workingDirectory,
    });
    // 附件找不到就只留字：失败占位（metadata.errorCode）不写进补投消息。
    resolvedAttachments = resolved.filter(
      (attachment) => attachment.metadata.errorCode === undefined,
    );
  }

  const messageId = options.messageId ?? createMessageId();
  const outcome = await this.persistUserPrompt(
    messageId,
    text,
    resolvedAttachments,
    options.traceContext,
    {
      createdAt: options.createdAt ?? record.time.created,
      intent,
      sessionInputId: record.id,
      sourceCommandId,
    },
  );

  // 共享上下文挂不上：正文已照常升格，模型额外收到一条仅模型可见的说明
  // （界面不画气泡）；live 会话同时补内存历史，下一轮模型才能读到。
  // 内存顺序与持久顺序一致：先用户正文、后说明。
  const skippedSharedContextIds = outcome.skippedSharedContextIds ?? [];
  if (options.hydrateIntoHistory) {
    this.messageHistory.addEntries(
      buildRuntimeUserEntriesFromTurn(text, resolvedAttachments ?? []),
    );
  }
  if (skippedSharedContextIds.length > 0) {
    const noticeText = buildSharedContextNoticeText(skippedSharedContextIds);
    await this.persistSyntheticUserNoticeForSession({
      messageID: createMessageId(),
      sessionId: this.sessionId,
      source: "shared_context",
      text: noticeText,
      traceContext: options.traceContext,
      visibility: "model-only",
    });
    if (options.hydrateIntoHistory) {
      this.messageHistory.addUser(
        noticeText,
        runtimeMetadataForSyntheticUserMessageSource("shared_context"),
      );
    }
  }

  this.logger?.info("Orphaned user input promoted into transcript", {
    ...traceContextToLogContext(options.traceContext),
    createdAt: options.createdAt ?? record.time.created,
    event: "session_input.orphan_promoted",
    messageId,
    module: "core.runtime",
    sessionInputId: record.id,
    skippedSharedContextCount: skippedSharedContextIds.length,
    sourceCommandId,
    status: "completed",
  });

  return {
    status: "promoted",
    messageId,
    ...(skippedSharedContextIds.length > 0 ? { skippedSharedContextIds } : {}),
  };
}
